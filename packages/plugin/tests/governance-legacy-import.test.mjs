/**
 * governance-legacy-import.test.mjs — WP8: legacy evidence import and the
 * authority cutover.
 *
 * The bar (governor-lead's five items, each pinned here):
 *   1. only one standing writer active, proven mechanically — source scan
 *      naming BOTH writers (with its vacuity self-check) AND a runtime
 *      assertion that the disabled writer REFUSES;
 *   2. import fabricates nothing — silent-advance baselines arrive as
 *      legacy-import evidence, never as acceptance, on a fixture whose
 *      baseline population is majority silent-advance (the real vault's
 *      shape);
 *   3. idempotent, provably — run twice, same store, no duplicates;
 *   4. rollback while the predecessor is read-only, with the fail direction
 *      stated: half-landed ⇒ legacy-still-authoritative;
 *   5. adopt-baseline retired as an ordinary control after cutover.
 * Plus the two adopted extras: the one-shot gestureRef (one gesture, one
 * claim, at runtime — every spelling) and #337's claims-exist-chain-absent
 * critical health check. Every refusal test carries a vacuity leg.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planLegacyImport, createLegacyEvidenceStore } from "../src/kernel/governance/migration/legacy-import.ts";
import { performCutover, rollbackCutover, CutoverRefusedError, LegacyWriterDisabledError, CUTOVER_DEFAULT } from "../src/kernel/governance/migration/cutover.ts";
import { BaselineStore } from "../src/kernel/governance/baseline-store.ts";
import { buildMigration } from "../src/governance/migration-wiring.ts";
import { standingHealth } from "../src/kernel/governance/admission/standing-health.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T0 = 1_800_000_000_000;

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The real vault's shape: most baselines were silent advances, not clicks (D04's whole point). */
function legacyFixture() {
  const baselines = [];
  for (let i = 0; i < 8; i++) {
    baselines.push({ path: `Notes/silent-${i}.md`, content: `body ${i}`, hash: `hash-s${i}`, acceptedAt: "2026-06-01T00:00:00Z", acceptedBy: "human-silent" });
  }
  for (let i = 0; i < 2; i++) {
    baselines.push({ path: `Notes/clicked-${i}.md`, content: `body c${i}`, hash: `hash-c${i}`, acceptedAt: "2026-06-02T00:00:00Z", acceptedBy: "human" });
  }
  const logLines = [
    JSON.stringify({ action: "accept", path: "Notes/clicked-0.md", ts: "2026-06-02T00:00:00Z", by: "human" }),
    JSON.stringify({ action: "accept", path: "Notes/clicked-1.md", ts: "2026-06-02T00:01:00Z", by: "human" }),
    ...Array.from({ length: 8 }, (_, i) => JSON.stringify({ event: "silent-advance", ts: "2026-06-01T00:00:00Z", path: `Notes/silent-${i}.md`, reason: "human-edit", fromHash: null, toHash: `hash-s${i}` })),
    JSON.stringify({ event: "auto-accept", ts: "2026-06-03T00:00:00Z", path: "Notes/auto-0.md" }),
    JSON.stringify({ action: "revert", path: "Notes/clicked-0.md", ts: "2026-06-04T00:00:00Z", by: "human" }),
    JSON.stringify({ event: "baseline-rekey", ts: "2026-06-05T00:00:00Z", path: "Notes/moved.md", from: "Notes/old.md", to: "Notes/moved.md", uid: null, hash: "hash-m" }),
    JSON.stringify({ action: "request-changes", path: "Notes/rc.md", ts: "2026-06-06T00:00:00Z", by: "human" }),
    "not json at all {",
  ];
  return {
    baselines,
    acceptanceLogLines: logLines,
    pendingIndexRaw: JSON.stringify({ pending: ["Notes/pending-0.md"] }),
    sources: { baselinesDir: "gov/baselines", acceptanceLog: "gov/acceptance-log.jsonl", pendingIndex: "gov/pending-index.json" },
  };
}

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

function memoryFsIo() {
  const files = new Map();
  return {
    files,
    exists: async (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(p + "/")),
    read: async (p) => files.get(p),
    write: async (p, d) => void files.set(p, d),
    append: async (p, d) => void files.set(p, (files.get(p) ?? "") + d),
    mkdir: async () => {},
  };
}

function memoryBlobFs() {
  const files = new Map();
  return {
    files,
    read: async (p) => {
      if (!files.has(p)) throw new Error("missing " + p);
      return files.get(p);
    },
    write: async (p, d) => void files.set(p, d),
    exists: async () => true, // dirs always "exist" for this double; mkdir is a no-op
    mkdir: async () => {},
    list: async (dir) => [...files.keys()].filter((k) => k.startsWith(dir + "/")),
    remove: async (p) => void files.delete(p),
  };
}

// ── D04: import fabricates nothing ──────────────────────────────────────────

describe("legacy import — evidence, never authority (D04)", () => {
  test("every legacy record becomes a legacy-import evidence record with source and legacy timestamp — none becomes an acceptance", () => {
    const plan = planLegacyImport(legacyFixture(), T0);
    assert.equal(plan.report.baselines, 10);
    // The D04 split, visible: the fixture is MAJORITY silent-advance, and the
    // report says which class was ever a click. Vacuity: the counts match the
    // fixture exactly, so this scan proves it can see every class.
    assert.equal(plan.report.acceptanceEvents.humanAccepts, 2);
    assert.equal(plan.report.acceptanceEvents.silentAdvances, 8);
    assert.equal(plan.report.acceptanceEvents.autoAccepts, 1);
    assert.equal(plan.report.acceptanceEvents.reverts, 1);
    assert.equal(plan.report.acceptanceEvents.rekeys, 1);
    assert.equal(plan.report.acceptanceEvents.dispositions, 1);
    assert.equal(plan.report.unparseableLines, 1, "the unparseable line is imported raw, not dropped");
    assert.ok(plan.report.acceptanceEvents.silentAdvances > plan.report.acceptanceEvents.humanAccepts, "the fixture is majority silent-advance — the real vault's shape");

    for (const rec of plan.records) {
      assert.equal(rec.record, "legacy-import");
      assert.ok(rec.kind.startsWith("legacy-"), "provenance is explicit in the kind");
      assert.ok(rec.source.file, "every record names its source");
      assert.equal(rec.importedAt, T0);
      // NO AUTHORITY FIELDS — no fabricated signatures, predicates,
      // admissions, or portable standing. The fields do not exist, and this
      // pin keeps them nonexistent.
      for (const forbidden of ["gestureRef", "verification", "predicates", "claimId", "expectedStanding", "coveredNotes", "authority", "subjectDigest"]) {
        assert.ok(!(forbidden in rec), `record must not carry ${forbidden}`);
        assert.ok(!(forbidden in rec.payload) || rec.kind === "legacy-acceptance-event", `payload must not gain ${forbidden} beyond what legacy recorded`);
      }
    }
    // Baseline evidence carries the HASH, not the content — no note bodies
    // duplicated into a second store.
    const baselineRecords = plan.records.filter((r) => r.kind === "legacy-baseline");
    assert.equal(baselineRecords.length, 10);
    for (const rec of baselineRecords) {
      assert.ok(!("content" in rec.payload), "baseline evidence carries the hash, never the body");
      assert.ok(rec.payload.hash);
    }
  });

  test("import is idempotent by importKey — run twice, same store, zero duplicates", async () => {
    const io = memoryIo();
    const store = createLegacyEvidenceStore(io);
    const plan = planLegacyImport(legacyFixture(), T0);
    const first = await store.importRecords(plan.records);
    assert.equal(first.appended, plan.records.length);
    assert.equal(first.skippedExisting, 0);
    const linesAfterFirst = [...io.lines];

    // Second run — even with a DIFFERENT importedAt (the key is payload-derived).
    const plan2 = planLegacyImport(legacyFixture(), T0 + 999_999);
    const second = await store.importRecords(plan2.records);
    assert.equal(second.appended, 0, "a re-run appends nothing");
    assert.equal(second.skippedExisting, plan2.records.length);
    assert.deepEqual(io.lines, linesAfterFirst, "the store is byte-identical after the second run");
    // Vacuity: a genuinely NEW record does append — the dedupe is by key,
    // not a wedged-shut store.
    const extra = planLegacyImport({ ...legacyFixture(), acceptanceLogLines: [JSON.stringify({ action: "accept", path: "Notes/new.md", ts: "2026-07-01T00:00:00Z", by: "human" })], pendingIndexRaw: null, baselines: [] }, T0);
    const third = await store.importRecords(extra.records);
    assert.equal(third.appended, 1);
  });
});

// ── The cutover ─────────────────────────────────────────────────────────────

describe("the cutover — one human act, flag-write-only, stated fail direction", () => {
  function memoryCutoverStore() {
    let stored = null;
    return {
      read: async () => stored ?? CUTOVER_DEFAULT,
      write: async (s) => void (stored = s),
      peek: () => stored,
    };
  }

  test("refuses without a gesture, refuses without an import report — and cuts over with both (vacuity)", async () => {
    const store = memoryCutoverStore();
    const report = planLegacyImport(legacyFixture(), T0).report;
    await assert.rejects(() => performCutover(store, "", report, T0), (e) => e instanceof CutoverRefusedError && e.code === "authority_missing");
    await assert.rejects(() => performCutover(store, "gesture-x", null, T0), (e) => e instanceof CutoverRefusedError && e.code === "import_missing");
    assert.equal(store.peek(), null, "a refused cutover writes NOTHING — legacy still authoritative");
    const state = await performCutover(store, "gesture-x", report, T0);
    assert.equal(state.cutOver, true);
    assert.equal(store.peek().cutOver, true, "the flag write IS the cutover");
    await assert.rejects(() => performCutover(store, "gesture-y", report, T0), (e) => e instanceof CutoverRefusedError && e.code === "already_cut_over");
  });

  test("FAIL DIRECTION: a failing state write leaves legacy authoritative — never both-or-neither", async () => {
    let stored = null;
    const store = {
      read: async () => stored ?? CUTOVER_DEFAULT,
      write: async () => {
        throw new Error("disk full (injected)");
      },
    };
    const report = planLegacyImport(legacyFixture(), T0).report;
    await assert.rejects(() => performCutover(store, "gesture-x", report, T0), /disk full/);
    assert.equal(stored, null, "half-landed ⇒ the flag is unwritten ⇒ legacy still authoritative");
  });

  test("rollback flips authority back with a gesture, and needs NOTHING from the disabled legacy machinery", async () => {
    const store = memoryCutoverStore();
    const report = planLegacyImport(legacyFixture(), T0).report;
    await performCutover(store, "gesture-x", report, T0);
    await assert.rejects(() => rollbackCutover(store, "", T0 + 1), (e) => e instanceof CutoverRefusedError && e.code === "authority_missing");
    const back = await rollbackCutover(store, "gesture-r", T0 + 1);
    assert.equal(back.cutOver, false);
    assert.equal(back.rolledBackAt, T0 + 1);
    assert.equal(back.importReport.totalRecords, report.totalRecords, "the confirmed report survives the flip for the audit trail");
    await assert.rejects(() => rollbackCutover(store, "gesture-r2", T0 + 2), (e) => e instanceof CutoverRefusedError && e.code === "not_cut_over");
  });
});

// ── Bar item 1: only one standing writer, proven mechanically ───────────────

describe("single standing writer — the disabled writer REFUSES", () => {
  test("RUNTIME: after cutover, setBaseline and rekey refuse; after rollback they work again (vacuity built in)", async () => {
    let cutOver = false;
    const store = new BaselineStore(memoryBlobFs(), "gov/baselines", () => !cutOver);
    await store.load();
    // Pre-cutover: the legacy writer works (this is the vacuity leg — the
    // guard is live and permissive, not bypassed).
    await store.setBaseline("Notes/a.md", "content", "human");
    assert.ok(store.has("Notes/a.md"));

    cutOver = true;
    await assert.rejects(() => store.setBaseline("Notes/b.md", "content", "human"), (e) => e instanceof LegacyWriterDisabledError && e.code === "legacy_writer_disabled");
    await assert.rejects(() => store.rekey("Notes/a.md", "Notes/a2.md"), (e) => e instanceof LegacyWriterDisabledError);
    assert.ok(!store.has("Notes/b.md"), "the refused write landed nothing");
    assert.ok(store.has("Notes/a.md"), "the refused rekey moved nothing");

    // Rollback re-enables — the predecessor was read-only throughout, and
    // nothing about the refusal wedged it.
    cutOver = false;
    await store.setBaseline("Notes/c.md", "content", "human");
    assert.ok(store.has("Notes/c.md"));
  });

  test("SOURCE: both standing writers are named, and every legacy baseline-advance call site funnels through the guarded store", () => {
    // The two standing writers of this codebase, named: the LEGACY writer is
    // BaselineStore.setBaseline (with rekey as its re-addressing sibling);
    // the NEW writer is the admission service's standingAdvance CAS. The
    // property "only one active after cutover" holds because every legacy
    // call site reaches the store's requireWritable gate — so the scan
    // proves: (a) both writers exist where claimed, (b) no setBaseline/rekey
    // implementation exists OUTSIDE the guarded store.
    const src = (rel) => fs.readFileSync(path.join(HERE, "..", "src", rel), "utf8");
    const baselineStore = src("kernel/governance/baseline-store.ts");
    assert.match(baselineStore, /requireWritable\("setBaseline/, "the legacy advance primitive is guarded");
    assert.match(baselineStore, /requireWritable\("rekey/, "the re-addressing sibling is guarded");
    const service = src("kernel/governance/admission/service.ts");
    assert.match(service, /standingAdvance\(expected, claim\.id\)/, "the new writer exists where claimed");

    // No second implementation: across src/**, `async setBaseline(` and
    // `async rekey(` appear ONLY in baseline-store.ts. GLOBBED, not a
    // hand-kept list (the Cycle 8 D4 rule).
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const p = path.join(dir, d.name);
        return d.isDirectory() ? walk(p) : d.name.endsWith(".ts") ? [p] : [];
      });
    const files = walk(path.join(HERE, "..", "src"));
    assert.ok(files.length > 50, "the glob genuinely walked the tree");
    // Two scans, and each assertion message states EXACTLY what its pattern
    // covers (the ninth-instance rule: a message that states the property
    // while the pattern checks a spelling is the family's purest shape —
    // governor-lead's planted `advanceBaselineBlob` passed the name scan
    // while producing byte-identical blobs).
    const isStore = (f) => f.endsWith(path.join("kernel", "governance", "baseline-store.ts"));
    const nameOffenders = files.filter((f) => !isStore(f) && /async setBaseline\(|async rekey\(/.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(nameOffenders, [], "no implementation NAMED setBaseline/rekey exists outside the store (name spellings only — the shape scan below covers renamed writers)");

    // What makes something a WRITER is producing the store's blob-path shape
    // — `<baseDir>/<contentHash(path)>.json` — under any method name. Both
    // template and concatenation spellings; legitimate only in the store.
    const shapePattern = /\$\{[^}]*contentHash\([^)]*\)[^}]*\}\.json|contentHash\([^)]*\)\s*\+\s*["'`]\.json/;
    const shapeOffenders = files.filter((f) => !isStore(f) && shapePattern.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(shapeOffenders, [], "no file outside the store constructs the baseline blob path shape (covers renamed writers; a writer with BOTH a novel name and a novel path construction remains a declared blind spot needing an author inside a reviewed file)");
    // And the shape scan is anchored: the store itself DOES use the shape.
    assert.ok(shapePattern.test(fs.readFileSync(files.find(isStore), "utf8")), "the store's own fileFor uses the shape the scan looks for — else the scan hunts a phantom");
  });

  test("VACUITY: the shape scan catches governor-lead's planted renamed writer", () => {
    // The exact plant from the #338 review: a writer under a different NAME
    // producing byte-identical blobs into the same directory. The name scan
    // cannot see it; the shape scan must.
    const planted =
      "export class Rogue {\n" +
      "  async advanceBaselineBlob(baseDir, notePath, content) {\n" +
      "    await this.fs.write(`${baseDir}/${contentHash(notePath)}.json`, JSON.stringify({ path: notePath, content }));\n" +
      "  }\n" +
      "}\n";
    assert.ok(!/async setBaseline\(|async rekey\(/.test(planted), "the name scan is blind to the renamed writer — which is why the shape scan exists");
    const shapePattern = /\$\{[^}]*contentHash\([^)]*\)[^}]*\}\.json|contentHash\([^)]*\)\s*\+\s*["'`]\.json/;
    assert.ok(shapePattern.test(planted), "the shape scan flags the plant");
    // And the concatenation spelling too.
    const plantedConcat = 'await fsx.write(baseDir + "/" + contentHash(p) + ".json", data);';
    assert.ok(shapePattern.test(plantedConcat), "the concatenation spelling is also flagged");
  });

  test("VACUITY: the source scan catches a planted unguarded writer", () => {
    // The scan's own detector run against a synthetic violation: an
    // implementation of the legacy writer outside the guarded store.
    const planted = "export class Rogue {\n  async setBaseline(path, content) { /* unguarded */ }\n}\n";
    assert.ok(/async setBaseline\(|async rekey\(/.test(planted), "the pattern the scan uses does flag the planted writer");
    // And the guarded-store pattern would NOT be satisfied by a store whose
    // gates were deleted.
    const gutted = fs.readFileSync(path.join(HERE, "..", "src", "kernel", "governance", "baseline-store.ts"), "utf8").replace(/requireWritable\("setBaseline[^\n]*\n/, "");
    assert.ok(!/requireWritable\("setBaseline/.test(gutted), "removing the gate is visible to the scan");
  });
});

// ── The migration wiring, end to end ────────────────────────────────────────

describe("migration wiring — import, cutover, rollback, status", () => {
  function wiredMigration(fsio, baselines) {
    return buildMigration({
      io: fsio,
      paths: {
        govDir: "gov",
        acceptanceLog: "gov/acceptance-log.jsonl",
        pendingIndex: "gov/pending-index.json",
        baselinesDir: "gov/baselines",
        legacyEvidence: "gov/legacy-evidence.jsonl",
        cutoverState: "gov/cutover.json",
      },
      baselines: () => baselines,
      now: () => T0,
    });
  }

  test("import → cutover → the guard flips → rollback → the guard flips back; the cutover re-runs the import idempotently", async () => {
    const fsio = memoryFsIo();
    const fixture = legacyFixture();
    fsio.files.set("gov/acceptance-log.jsonl", fixture.acceptanceLogLines.join("\n"));
    fsio.files.set("gov/pending-index.json", fixture.pendingIndexRaw);
    const migration = wiredMigration(fsio, fixture.baselines);
    await migration.loadState();
    assert.equal(migration.isCutOver(), false, "fresh vault: legacy authoritative");

    const imported = await migration.importLegacyEvidence();
    assert.equal(imported.appended, imported.report.totalRecords);

    const state = await migration.cutOver("gesture-cut");
    assert.equal(state.cutOver, true);
    assert.equal(migration.isCutOver(), true, "the SYNC guard sees the flip immediately");
    assert.equal(state.importReport.totalRecords, imported.report.totalRecords, "the confirmed report is the re-run import's — idempotent, so identical");
    const status = await migration.status();
    assert.equal(status.evidenceRecords, imported.report.totalRecords, "the cutover's re-import appended nothing new");

    const back = await migration.rollback("gesture-roll");
    assert.equal(back.cutOver, false);
    assert.equal(migration.isCutOver(), false);
  });

  test("a corrupt cutover file fails toward FEWER writers: guard refuses legacy, status says corrupt", async () => {
    const fsio = memoryFsIo();
    fsio.files.set("gov/cutover.json", "{ not json");
    const migration = wiredMigration(fsio, []);
    await migration.loadState();
    assert.equal(migration.isCutOver(), true, "ambiguity must not silently re-enable a second standing writer");
    const status = await migration.status();
    assert.equal(status.corrupt, true, "and the status surface says WHY");
    // Vacuity: a VALID file reads normally.
    fsio.files.set("gov/cutover.json", JSON.stringify({ ...CUTOVER_DEFAULT }));
    await migration.loadState();
    assert.equal(migration.isCutOver(), false);
  });
});

// ── #337 option 4: standing health ──────────────────────────────────────────

describe("standing health — the chain-absent direction is LOUD", () => {
  const claimsWith = (n) => ({
    all: async () => Array.from({ length: n }, (_, i) => ({ id: `claim-${i}` })),
  });

  test("claims exist + chain absent ⇒ CRITICAL (the #337 disk-loss signature); every other shape answers honestly", async () => {
    const orphaned = await standingHealth({ claims: claimsWith(3), standingChain: async () => [] });
    assert.equal(orphaned.status, "critical");
    assert.equal(orphaned.code, "chain_absent");
    assert.match(orphaned.detail, /ungoverned/, "the detail names the silent-downgrade consequence");

    const empty = await standingHealth({ claims: claimsWith(0), standingChain: async () => [] });
    assert.equal(empty.status, "ok");
    assert.equal(empty.code, "empty");

    const healthy = await standingHealth({ claims: claimsWith(3), standingChain: async () => ["claim-2", "claim-1", "claim-0"] });
    assert.equal(healthy.status, "ok");
    assert.equal(healthy.code, "healthy");

    const unreadable = await standingHealth({
      claims: claimsWith(3),
      standingChain: async () => {
        throw new Error("dangling ref");
      },
    });
    assert.equal(unreadable.status, "critical");
    assert.equal(unreadable.code, "chain_unreadable");
  });

  test("VACUITY: the critical branch is reachable from the healthy one by exactly the failure it names", async () => {
    // One deps object, one mutation — losing the chain — flips the verdict.
    let chain = ["claim-0"];
    const deps = { claims: claimsWith(1), standingChain: async () => chain };
    assert.equal((await standingHealth(deps)).status, "ok");
    chain = [];
    assert.equal((await standingHealth(deps)).status, "critical", "the check fires on the exact orphaned-claims state");
  });
});

// ── No bulk re-acceptance door ──────────────────────────────────────────────

describe("selective re-acceptance only — the migration cannot mint standing", () => {
  test("the migration modules import NOTHING from the admission machinery — no claim construction is reachable", () => {
    // Selective re-acceptance into new standing is the ORDINARY path
    // (proposal → verification → gesture → admission, covered by the
    // admission suites). What must NOT exist is a bulk door here: a
    // migration module that could construct claims or advance standing.
    // Pinned structurally: neither migration module imports from admission/,
    // the history store, or the claim builder.
    for (const rel of ["kernel/governance/migration/legacy-import.ts", "kernel/governance/migration/cutover.ts", "governance/migration-wiring.ts"]) {
      const text = fs.readFileSync(path.join(HERE, "..", "src", rel), "utf8");
      for (const forbidden of ["admission/", "settlement", "buildAdmissionClaim", "standingAdvance", "history-store"]) {
        assert.ok(!text.includes(forbidden), `${rel} must not reach ${forbidden}`);
      }
    }
    // Vacuity: the scan detects a planted import.
    const planted = 'import { buildAdmissionClaim } from "../admission/settlement.js";';
    assert.ok(["admission/", "settlement", "buildAdmissionClaim"].some((f) => planted.includes(f)));
  });
});

// ── Regressions from the independent review of PR #338 ──────────────────────

describe("review regressions — duplicate lines, concurrency, fail-open, half-write", () => {
  test("two byte-identical acceptance-log lines are TWO records — identity includes the source line", async () => {
    const dupLine = JSON.stringify({ action: "accept", path: "Notes/dup.md", ts: "2026-06-01T00:00:00Z", by: "human" });
    const plan = planLegacyImport(
      { baselines: [], acceptanceLogLines: [dupLine, dupLine], pendingIndexRaw: null, sources: { baselinesDir: "b", acceptanceLog: "log", pendingIndex: "p" } },
      T0
    );
    assert.equal(plan.records.length, 2);
    assert.notEqual(plan.records[0].importKey, plan.records[1].importKey, "line-position distinguishes identical payloads");
    const io = memoryIo();
    const store = createLegacyEvidenceStore(io);
    const { appended, skippedExisting } = await store.importRecords(plan.records);
    assert.equal(appended, 2, "nothing silently dropped inside a single first run");
    assert.equal(skippedExisting, 0);
    // And the RE-RUN still dedupes both — idempotency survives the richer key.
    const again = await store.importRecords(planLegacyImport({ baselines: [], acceptanceLogLines: [dupLine, dupLine], pendingIndexRaw: null, sources: { baselinesDir: "b", acceptanceLog: "log", pendingIndex: "p" } }, T0 + 5).records);
    assert.equal(again.appended, 0);
  });

  test("two CONCURRENT imports of the same plan do not double-append — the store serializes", async () => {
    const lines = [];
    const slowIo = {
      appendLine: async (l) => {
        await new Promise((r) => setTimeout(r, 2));
        lines.push(l);
      },
      readLines: async () => {
        await new Promise((r) => setTimeout(r, 2));
        return [...lines];
      },
    };
    const store = createLegacyEvidenceStore(slowIo);
    const plan = planLegacyImport(legacyFixture(), T0);
    const [a, b] = await Promise.all([store.importRecords(plan.records), store.importRecords(plan.records)]);
    assert.equal(lines.length, plan.records.length, "the store holds each record ONCE despite overlapping runs");
    assert.equal(a.appended + b.appended, plan.records.length);
    assert.equal(a.skippedExisting + b.skippedExisting, plan.records.length);
  });

  test("an exists-throw on the cutover state fails toward FEWER writers, not open", async () => {
    const fsio = memoryFsIo();
    const throwingIo = {
      ...fsio,
      exists: async (p) => {
        if (p.endsWith("cutover.json")) throw new Error("adapter stall (injected)");
        return fsio.exists(p);
      },
    };
    const migration = buildMigration({
      io: throwingIo,
      paths: { govDir: "gov", acceptanceLog: "gov/a.jsonl", pendingIndex: "gov/p.json", baselinesDir: "gov/baselines", legacyEvidence: "gov/e.jsonl", cutoverState: "gov/cutover.json" },
      baselines: () => [],
      now: () => T0,
    });
    await migration.loadState();
    assert.equal(migration.isCutOver(), true, "an unreadable flag must not silently run two standing writers");
    const status = await migration.status().catch(() => null);
    if (status) assert.equal(status.corrupt, true);
  });

  test("rollback REFUSES while the state file is corrupt — ambiguity is repaired, never laundered", async () => {
    const fsio = memoryFsIo();
    fsio.files.set("gov/cutover.json", "{ not json");
    const migration = buildMigration({
      io: fsio,
      paths: { govDir: "gov", acceptanceLog: "gov/a.jsonl", pendingIndex: "gov/p.json", baselinesDir: "gov/baselines", legacyEvidence: "gov/e.jsonl", cutoverState: "gov/cutover.json" },
      baselines: () => [],
      now: () => T0,
    });
    await migration.loadState();
    await assert.rejects(() => migration.rollback("gesture-r"), (e) => e instanceof CutoverRefusedError && e.code === "state_corrupt");
    assert.equal(fsio.files.get("gov/cutover.json"), "{ not json", "the unparseable file is untouched — whatever it records survives for the human");
  });

  test("SOURCE: performAccept and performRevert refuse at ENTRY, before any stamp — pinned with vacuity", () => {
    // The half-write finding: acceptNote stamps `acceptance-status: accepted`
    // FIRST and advances the baseline second, so a post-cutover Accept that
    // only the store guard stopped left a permanent stamp with no baseline
    // and no admission. The refusal must precede the acceptNote/revertNote
    // call. Declared for what it is: a source-order pin (the wiring imports
    // `obsidian`, so the behavior is not headless-runnable here).
    const raw = fs.readFileSync(path.join(HERE, "..", "src", "governance", "wiring.ts"), "utf8");
    for (const [fn, delegate] of [["performAccept", "acceptNote("], ["performRevert", "revertNote("]]) {
      const at = raw.indexOf(`async function ${fn}(`);
      assert.notEqual(at, -1, `${fn} exists`);
      const body = raw.slice(at, raw.indexOf("\nasync function", at + 10));
      const guardAt = body.indexOf("legacyRetired(plugin)");
      const callAt = body.indexOf(delegate);
      assert.ok(guardAt !== -1 && callAt !== -1, `${fn} carries both the guard and the delegate call`);
      assert.ok(guardAt < callAt, `${fn} refuses BEFORE ${delegate} — no half-write window`);
    }
    // Vacuity: swapping the order is visible to this scan.
    const swapped = "async function performAccept(x) {\n  return await acceptNote(deps, path);\n  if (legacyRetired(plugin)) throw new Error();\n}\nasync function next() {}";
    const body = swapped.slice(0, swapped.indexOf("\nasync function next"));
    assert.ok(body.indexOf("legacyRetired(plugin)") > body.indexOf("acceptNote("), "the scan distinguishes guard-after-call");
  });
});
