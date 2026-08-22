/**
 * governance-cohort-ui.test.mjs — WP7b: the cohort gesture, end to end.
 *
 * One gesture, one claim covering N subjects, one CAS — against the REAL
 * history repository. The properties: the frozen digest is RECOMPUTED at
 * decision time (tampering refuses); any drifted member aborts WHOLE with
 * the items named; coverage is the service's own run; the claim's
 * coveredNotes are DERIVED from the manifest (pinned equal); the resolver
 * answers per member off the real chain; split-by-finding stages a
 * successor that is its own decision; and §15's family binds the cohort
 * gesture identically.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAdmission } from "../src/governance/admission-wiring.ts";
import { openGitRepository } from "../src/governance/history-store/git-repository.ts";
import { proposalRef, standingRef } from "../src/kernel/governance/history-store/refs.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { subjectDigest } from "../src/kernel/governance/contracts/subject-v1.ts";
import { digestBytes } from "../src/kernel/governance/contracts/digest.ts";
import { createStandingResolver } from "../src/kernel/governance/admission/standing-resolver.ts";
import { createClaimStore } from "../src/kernel/governance/admission/settlement.ts";
import { runGuardedDisposition } from "../src/kernel/governance/gesture.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const enc = (s) => new TextEncoder().encode(s);
const T0 = 1_700_000_000_000;

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

async function harness(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-cohort-ui-"));
  const repo = await openGitRepository({ gitdir: path.join(root, "gitdir"), worktree: path.join(root, "vault") });
  const vault = new Map();
  const proposals = createProposalStore(memoryIo());
  const claimIo = memoryIo();
  const admission = buildAdmission({
    repo: async () => repo,
    claimIo,
    proposals,
    readNoteBytes: async (p) => (vault.has(p) ? enc(vault.get(p)) : null),
    writeNoteBytes: async (p, bytes) => void vault.set(p, new TextDecoder().decode(bytes)),
    appendSettlement: opts.appendSettlement ?? (async () => {}),
    now: () => T0,
  });
  let seq = 0;
  const noteIds = new Map(); // path → stable noteId: re-producing a note keeps its IDENTITY
  async function produce(notePath, baseText, proposedText, noteId = null) {
    seq++;
    if (noteId !== null) noteIds.set(notePath, noteId);
    if (!noteIds.has(notePath)) noteIds.set(notePath, `uid-${String(noteIds.size + 1).padStart(3, "0")}`);
    if (baseText !== null) vault.set(notePath, baseText);
    vault.set(notePath, proposedText);
    const subject = buildProposalSubjectFromOperation({
      vaultId: "vault-1",
      noteId: noteIds.get(notePath),
      path: notePath,
      pathSemanticallyRelevant: false,
      base: baseText === null ? null : digestBytes(enc(baseText)),
      proposed: digestBytes(enc(proposedText)),
      changeClasses: ["content"],
      transformation: { id: "note.write", version: "1" },
      predicates: [{ id: "content-diff", version: "1" }],
      producingOperation: { id: `op-${seq}`, action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId: null,
    });
    const proposal = openProposal({ subject, sessionId: "sess-1" }, T0 + seq, new Uint8Array(10).fill(seq));
    const ref = proposalRef(proposal.id);
    const base = await repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: baseText === null ? null : enc(baseText) }],
      message: "base",
      timestamp: 1,
      expectedRef: null,
    });
    await repo.recordSnapshot({ ref, files: [{ path: notePath, bytes: enc(proposedText) }], message: "proposed", timestamp: 2, expectedRef: base.oid });
    const full = { ...proposal, recordingRef: ref };
    await proposals.open(full, T0);
    return full;
  }
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { repo, vault, proposals, claimIo, admission, produce, cleanup };
}

describe("the cohort gesture — one claim covering N, against the real repository", () => {
  let h;
  before(async () => {
    h = await harness();
  });
  after(() => h.cleanup());

  test("freeze the selection, admit under ONE gesture, resolve every member off the real chain", async () => {
    for (let i = 0; i < 5; i++) await h.produce(`Notes/batch-${i}.md`, `old ${i}\n`, `new ${i}\n`);
    const sel = await h.admission.freezeSelection({ folder: "Notes" }, "item");
    assert.ok(sel.ok, sel.reason);
    assert.equal(sel.frozen.subject.items.length, 5);

    const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-cohort-1");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.receipt.memberCount, 5);
    assert.equal(outcome.receipt.subjectDigest, sel.frozen.digest.value, "the claim covers the FROZEN digest");

    // ONE claim, coveredNotes derived equal to the manifest — pinned.
    const claims = createClaimStore(h.claimIo);
    const all = await claims.all();
    assert.equal(all.length, 1);
    assert.deepEqual(
      all[0].coveredNotes.map((n) => `${n.noteId}:${n.subjectDigest}`).sort(),
      sel.frozen.subject.items.map((i) => `${i.noteId}:${subjectDigest(i).value}`).sort(),
      "coveredNotes IS the manifest, derived, never supplied"
    );

    // The resolver answers per member off the real standing chain.
    const chain = async () => {
      const oids = await h.repo.log(standingRef(), 100);
      return oids.map((c) => /^admission ([0-9a-f-]+)/.exec(c.message + "\n")[1]);
    };
    const resolver = createStandingResolver({ claims, standingChain: chain });
    for (const item of sel.frozen.subject.items) {
      const answer = await resolver.forSubject(subjectDigest(item).value);
      assert.equal(answer.state, "admitted", `${item.noteId} stands`);
      assert.equal(answer.claim.id, outcome.claimId);
    }
    // Projections caught up.
    for (const m of sel.members) {
      assert.equal((await h.proposals.get(m.id)).authority, "admitted");
    }
  });

  test("ONE drifted member aborts the WHOLE decision, named — nothing advances", async () => {
    const a = await h.produce("Drift/a.md", "base-a\n", "prop-a\n");
    const b = await h.produce("Drift/b.md", "base-b\n", "prop-b\n");
    const sel = await h.admission.freezeSelection({ folder: "Drift" }, "item");
    assert.ok(sel.ok);
    h.vault.set("Drift/b.md", "EDITED AFTER FREEZE\n");
    const before = await h.repo.resolveRef(standingRef());
    const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-drift");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "subject_drift");
    assert.deepEqual(outcome.failedNoteIds, [b.subject.noteId], "the drifted member is NAMED");
    assert.equal(await h.repo.resolveRef(standingRef()), before, "standing untouched — whole-abort");
    assert.equal((await h.proposals.get(a.id)).authority, "proposed", "the clean member also remains proposed");
  });

  test("a TAMPERED frozen structure refuses — the digest is recomputed, never trusted", async () => {
    await h.produce("Tamper/a.md", "b\n", "p\n");
    const sel = await h.admission.freezeSelection({ folder: "Tamper" }, "item");
    assert.ok(sel.ok);
    // The structure is deep-frozen; simulate a tampered PRESENTATION instead:
    // a frozen object whose digest field claims something its subject is not.
    const tampered = { subject: sel.frozen.subject, digest: { algorithm: "sha256", value: "f".repeat(64) }, memberProposalIds: sel.frozen.memberProposalIds };
    const outcome = await h.admission.admitCohortWithGesture(tampered, sel.members, "gesture-tamper");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "subject_drift");
  });

  test("split by finding: exclude the failing members into a successor that admits under ITS OWN ref", async () => {
    for (let i = 0; i < 4; i++) await h.produce(`Split/n-${i}.md`, `o ${i}\n`, `p ${i}\n`);
    const sel = await h.admission.freezeSelection({ folder: "Split" }, "item");
    assert.ok(sel.ok);
    // Two members drift.
    h.vault.set("Split/n-1.md", "CHANGED\n");
    h.vault.set("Split/n-3.md", "ALSO CHANGED\n");
    const first = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-split-1");
    assert.ok(!first.ok);
    assert.equal(first.failedNoteIds.length, 2);

    const failedSet = new Set(first.failedNoteIds);
    const excludeIds = sel.frozen.subject.items
      .map((item, i) => (failedSet.has(item.noteId) ? sel.frozen.memberProposalIds[i] : null))
      .filter((x) => x !== null);
    const split = await h.admission.refreezeWithout(sel.frozen, sel.members, excludeIds, "item");
    assert.ok(split.ok, split.reason);
    assert.equal(split.frozen.subject.items.length, 2);
    assert.equal(split.frozen.subject.excludedProposalIds.length, 2, "the exclusions ride the successor's own manifest");
    assert.notEqual(split.frozen.digest.value, sel.frozen.digest.value);

    const second = await h.admission.admitCohortWithGesture(split.frozen, split.members, "gesture-split-2");
    assert.ok(second.ok, JSON.stringify(second));
    assert.equal(second.receipt.memberCount, 2);
    // The excluded remain proposed — their own path, never silently dropped.
    for (const id of excludeIds) {
      assert.equal((await h.proposals.get(id)).authority, "proposed");
    }
  });

  test("re-admitting the SAME cohort refuses already_admitted; a MEMBER re-admitted individually flips alone", async () => {
    const p0 = await h.produce("Chain2/x.md", "v0\n", "v1\n");
    const p1 = await h.produce("Chain2/y.md", "w0\n", "w1\n");
    const sel = await h.admission.freezeSelection({ folder: "Chain2" }, "item");
    assert.ok(sel.ok);
    const first = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "g-1");
    assert.ok(first.ok, JSON.stringify(first));
    const again = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "g-2");
    assert.ok(!again.ok);
    assert.equal(again.code, "already_admitted");

    // Individually re-admit x at new content: only x flips.
    const p2 = await h.produce("Chain2/x.md", "v1\n", "v2\n");
    const solo = await h.admission.admitWithGesture(p2.id, "g-3");
    assert.ok(solo.ok, JSON.stringify(solo));
    const claims = createClaimStore(h.claimIo);
    const chain = async () => (await h.repo.log(standingRef(), 100)).map((c) => /^admission ([0-9a-f-]+)/.exec(c.message + "\n")[1]);
    const resolver = createStandingResolver({ claims, standingChain: chain });
    const xOld = await resolver.forSubject(subjectDigest(sel.frozen.subject.items.find((i) => i.noteId === p0.subject.noteId)).value);
    assert.equal(xOld.state, "superseded", "x's cohort-covered subject is superseded by its solo re-admission");
    const y = await resolver.forSubject(subjectDigest(sel.frozen.subject.items.find((i) => i.noteId === p1.subject.noteId)).value);
    assert.equal(y.state, "admitted", "y stands untouched");
  });
});

// ── §15 on the cohort gesture ────────────────────────────────────────────────

describe("§15 — the cohort gesture is gated identically", () => {
  test("a synthetic event cannot reach freeze-or-admit; forged objects blocked", async () => {
    let reached = false;
    for (const forged of [{ isTrusted: false, type: "click" }, {}, { isTrusted: true }]) {
      const outcome = await runGuardedDisposition(forged, null, async () => {
        reached = true;
      });
      assert.equal(outcome, "blocked-untrusted");
    }
    assert.equal(reached, false);
  });

  test("the pane wires Group & admit AND the successor through the shared gate; one gesture covers one claim — pinned", () => {
    const raw = fs.readFileSync(path.join(HERE, "..", "src", "governance", "pane.ts"), "utf8");
    const lines = raw.split("\n");
    for (const el of ["groupBtn", "sucBtn"]) {
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (new RegExp(`${el}\\.addEventListener\\(`).test(lines[i])) {
          assert.match(lines.slice(i, i + 5).join("\n"), /runGuardedDisposition/, `${el} routes through the shared gate`);
          found = true;
        }
      }
      assert.ok(found, `${el} exists and is addEventListener-wired`);
    }
    // The successor is its OWN decision: the split path stages it and never
    // admits a second claim inside the original click's action. The pin is a
    // STRUCTURAL scan of decideCohort's body, not a literal-text match (a
    // violation spelled through parameters would dodge any literal): within
    // one decideCohort run there is exactly ONE admitCohortWithGesture call
    // and NO recursive decideCohort call, so a second claim can only be
    // reached through a second gate run (the staged successor's own button).
    assert.match(raw, /pendingSuccessor/, "the successor is staged, not auto-admitted");
    const body = extractMethodBody(raw, "async decideCohort");
    assert.ok(scanOneAdmissionPerGate(body), "decideCohort admits at most once per gesture");
  });

  test("vacuity: the one-admission-per-gate scan CATCHES the violation it exists to catch", () => {
    const raw = fs.readFileSync(path.join(HERE, "..", "src", "governance", "pane.ts"), "utf8");
    const body = extractMethodBody(raw, "async decideCohort");
    assert.ok(scanOneAdmissionPerGate(body), "the real body passes");
    // The exact regression the review demonstrated: auto-admitting the split
    // successor under the ORIGINAL click's ref, spelled through parameters so
    // no literal-text pin could see it. The scan must fail this mutant.
    const mutantRecurse = body.replace(
      "this.pendingSuccessor = { frozen: split.frozen, members: split.members, excludedNoteIds: failedNoteIds };",
      "this.pendingSuccessor = null; await this.decideCohort(deps, split.frozen, split.members, gestureRef);"
    );
    assert.notEqual(mutantRecurse, body, "the mutation site exists");
    assert.ok(!scanOneAdmissionPerGate(mutantRecurse), "a recursive second decision is caught");
    // The other spelling: a second direct admission call in the same body.
    const mutantDirect = body.replace(
      "this.pendingSuccessor = { frozen: split.frozen, members: split.members, excludedNoteIds: failedNoteIds };",
      "await deps.admission.admitCohortWithGesture(split.frozen, split.members, gestureRef);"
    );
    assert.ok(!scanOneAdmissionPerGate(mutantDirect), "a second direct admission is caught");
    // Third spelling: admitting the successor's members one by one through
    // the ITEM path under the original ref — no cohort call, same violation.
    const mutantItemPath = body.replace(
      "this.pendingSuccessor = { frozen: split.frozen, members: split.members, excludedNoteIds: failedNoteIds };",
      "for (const m of split.members) await deps.admission.admitWithGesture(m.id, gestureRef);"
    );
    assert.ok(!scanOneAdmissionPerGate(mutantItemPath), "an item-path smuggle is caught");
  });

  test("vacuity: the pins match real wiring sites", () => {
    const raw = fs.readFileSync(path.join(HERE, "..", "src", "governance", "pane.ts"), "utf8");
    assert.ok(/groupBtn\.addEventListener\(/.test(raw));
    assert.ok(/sucBtn\.addEventListener\(/.test(raw));
  });
});

// ── Scan helpers for the one-admission-per-gate pin ─────────────────────────

/** Extract a method's brace-balanced body from source, starting at its signature. */
function extractMethodBody(source, signature) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, `${signature} exists in pane.ts`);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail("unbalanced braces extracting " + signature);
}

/**
 * One gate run admits at most once: exactly one admitCohortWithGesture call,
 * no recursive decideCohort, and no ITEM-path admission smuggled in (the
 * spelling "admitWithGesture(" is not a substring of the cohort call's name,
 * so the real body counts 0). A helper-method indirection remains a declared
 * blind spot of any single-method text scan — recorded, not closed.
 */
function scanOneAdmissionPerGate(body) {
  const admits = (body.match(/admitCohortWithGesture\(/g) ?? []).length;
  const recursions = (body.match(/decideCohort\(/g) ?? []).length;
  // NOT admits-subtracted: "admitCohortWithGesture(" does not contain the
  // substring "admitWithGesture(" (Cohort sits between), so this counts
  // exactly the genuine item-path calls.
  const itemAdmits = (body.match(/admitWithGesture\(/g) ?? []).length;
  return admits === 1 && recursions === 0 && itemAdmits === 0;
}

// ── Regressions from the independent review of PR #336 ──────────────────────

describe("review regressions — correlation, staleness, concurrency, degradation", () => {
  test("a cohort whose noteIds do NOT ascend in selection order admits fine — identity correlation, never positional", async () => {
    const h = await harness();
    try {
      // Selection order zeta, mmm, alpha; canonical item order alpha, mmm, zeta.
      await h.produce("Mixed/one.md", "b1\n", "p1\n", "uid-zeta");
      await h.produce("Mixed/two.md", "b2\n", "p2\n", "uid-mmm");
      await h.produce("Mixed/three.md", "b3\n", "p3\n", "uid-alpha");
      const sel = await h.admission.freezeSelection({ folder: "Mixed" }, "item");
      assert.ok(sel.ok, sel.reason);
      assert.notDeepEqual(
        sel.frozen.subject.items.map((i) => i.noteId),
        ["uid-zeta", "uid-mmm", "uid-alpha"],
        "canonical order genuinely differs from selection order — else this test is vacuous"
      );
      const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-mixed");
      assert.ok(outcome.ok, JSON.stringify(outcome));
      assert.equal(outcome.receipt.memberCount, 3);
    } finally {
      h.cleanup();
    }
  });

  test("an open revision request on ONE member refuses the WHOLE cohort at click time — bytes unchanged, facts fresh", async () => {
    const h = await harness();
    try {
      const a = await h.produce("Rev/a.md", "ba\n", "pa\n");
      const b = await h.produce("Rev/b.md", "bb\n", "pb\n");
      const sel = await h.admission.freezeSelection({ folder: "Rev" }, "item");
      assert.ok(sel.ok);
      // Between freeze and click, a human requests revision on b. No note
      // bytes change, so drift and coverage both pass — only fresh proposal
      // facts can see the objection.
      await h.proposals.requestRevision(b.id, T0 + 100);
      const before = await h.repo.resolveRef(standingRef());
      const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-rev");
      assert.ok(!outcome.ok, "the cohort must not admit over an open human objection");
      assert.equal(outcome.code, "revision_open");
      assert.deepEqual(outcome.failedNoteIds, [b.subject.noteId], "the objected member is NAMED, structurally");
      assert.equal(await h.repo.resolveRef(standingRef()), before, "standing untouched");
      assert.equal((await h.proposals.get(a.id)).authority, "proposed");
    } finally {
      h.cleanup();
    }
  });

  test("two CONCURRENT disjoint cohort admissions both succeed — no shared evidence state to race", async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 3; i++) await h.produce(`ConA/n-${i}.md`, `a${i}\n`, `pa${i}\n`);
      for (let i = 0; i < 3; i++) await h.produce(`ConB/n-${i}.md`, `b${i}\n`, `pb${i}\n`);
      const selA = await h.admission.freezeSelection({ folder: "ConA" }, "item");
      const selB = await h.admission.freezeSelection({ folder: "ConB" }, "item");
      assert.ok(selA.ok && selB.ok);
      const [oa, ob] = await Promise.all([
        h.admission.admitCohortWithGesture(selA.frozen, selA.members, "gesture-con-a"),
        h.admission.admitCohortWithGesture(selB.frozen, selB.members, "gesture-con-b"),
      ]);
      assert.ok(oa.ok, JSON.stringify(oa));
      assert.ok(ob.ok, JSON.stringify(ob));
      assert.notEqual(oa.claimId, ob.claimId);
      const claims = createClaimStore(h.claimIo);
      assert.equal((await claims.all()).length, 2);
    } finally {
      h.cleanup();
    }
  });

  test("a settlement-append failure AFTER the CAS reports a DEGRADED success — the admission stands and projections advance", async () => {
    let failNext = false;
    const h = await harness({
      appendSettlement: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("disk full (injected)");
        }
      },
    });
    try {
      for (let i = 0; i < 2; i++) await h.produce(`Deg/n-${i}.md`, `d${i}\n`, `pd${i}\n`);
      const sel = await h.admission.freezeSelection({ folder: "Deg" }, "item");
      assert.ok(sel.ok);
      failNext = true;
      const outcome = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-deg");
      assert.ok(outcome.ok, "the CAS landed — reporting failure would misdescribe standing authority: " + JSON.stringify(outcome));
      assert.equal(outcome.degraded, true, "the receipt says the settlement record is missing");
      // The claim genuinely stands and every member projection caught up.
      const head = await h.repo.resolveRef(standingRef());
      assert.notEqual(head, null);
      for (const m of sel.members) {
        assert.equal((await h.proposals.get(m.id)).authority, "admitted", "projections advanced despite the degraded receipt");
      }
      // And the degraded path did not fabricate success out of thin air:
      // vacuity — the same harness admits NON-degraded when nothing fails.
      for (let i = 0; i < 2; i++) await h.produce(`Deg2/n-${i}.md`, `e${i}\n`, `pe${i}\n`);
      const sel2 = await h.admission.freezeSelection({ folder: "Deg2" }, "item");
      const clean = await h.admission.admitCohortWithGesture(sel2.frozen, sel2.members, "gesture-deg-2");
      assert.ok(clean.ok && clean.degraded === false, "an unfaulted admission is NOT degraded");
    } finally {
      h.cleanup();
    }
  });
});

// ── WP8: one gesture, one claim — at RUNTIME, every spelling ────────────────

describe("one-shot gestureRef — a gesture authorises exactly one claim", () => {
  test("a replayed ref refuses on the item path, the cohort path, and across the two — fresh refs admit (vacuity)", async () => {
    const h = await harness();
    try {
      const a = await h.produce("Shot/a.md", "a0\n", "a1\n");
      const solo = await h.admission.admitWithGesture(a.id, "gesture-once");
      assert.ok(solo.ok, JSON.stringify(solo));

      // Item-path replay: a DIFFERENT subject under the used ref.
      const b = await h.produce("Shot/b.md", "b0\n", "b1\n");
      const replayItem = await h.admission.admitWithGesture(b.id, "gesture-once");
      assert.ok(!replayItem.ok, "a used gesture must not authorise a second claim");
      assert.equal(replayItem.code, "gesture_replayed");

      // Cohort-path replay of the same ref.
      await h.produce("Shot/c.md", "c0\n", "c1\n");
      const sel = await h.admission.freezeSelection({ folder: "Shot" }, "item");
      assert.ok(sel.ok);
      const replayCohort = await h.admission.admitCohortWithGesture(sel.frozen, sel.members, "gesture-once");
      assert.ok(!replayCohort.ok);
      assert.equal(replayCohort.code, "gesture_replayed");

      // Vacuity: the same decisions under FRESH refs admit fine — the
      // refusal is about the ref, not the subjects.
      const fresh = await h.admission.admitWithGesture(b.id, "gesture-two");
      assert.ok(fresh.ok, JSON.stringify(fresh));
      const sel2 = await h.admission.freezeSelection({ folder: "Shot" }, "item");
      assert.ok(sel2.ok);
      const freshCohort = await h.admission.admitCohortWithGesture(sel2.frozen, sel2.members, "gesture-three");
      assert.ok(freshCohort.ok, JSON.stringify(freshCohort));
      // And a cohort-used ref refuses on the ITEM path too — the token is
      // one-shot across BOTH doors.
      const d = await h.produce("Shot/d.md", "d0\n", "d1\n");
      const crossReplay = await h.admission.admitWithGesture(d.id, "gesture-three");
      assert.ok(!crossReplay.ok);
      assert.equal(crossReplay.code, "gesture_replayed");
    } finally {
      h.cleanup();
    }
  });
});
