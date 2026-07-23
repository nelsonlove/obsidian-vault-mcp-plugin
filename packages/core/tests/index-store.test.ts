import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Tests for src/index-store.ts — pin down current semantics before the
 * incremental update PR (#23 follow-up) can safely change the implementation.
 *
 * Approach: one shared tmpdir as VAULT_PATH. Each test wipes the tmpdir,
 * writes fixture files, calls buildIndex(), then asserts via the exported
 * query functions. Tests are not parallel-safe — the module's `state` is
 * singleton, and `node --test` does run tests within a single file
 * sequentially, so this is fine for our purposes.
 */

let tmpRoot: string;
// Imports happen after VAULT_PATH is set in `before` — see below.
type IndexStoreModule = typeof import("../src/fs-backend/index-store.js");
let indexStore: IndexStoreModule;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vault-mcp-test-"));
  process.env.VAULT_PATH = tmpRoot;
  // Dynamic import AFTER env is set — vault.ts captures VAULT_PATH at module
  // load time as a const, so the env must be set first.
  indexStore = await import("../src/fs-backend/index-store.js");
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Wipe disk fixtures from the prior test.
  for (const entry of await fs.readdir(tmpRoot)) {
    await fs.rm(path.join(tmpRoot, entry), { recursive: true, force: true });
  }
  // Reset the index module's singleton state by rebuilding against the now-
  // empty tmpdir. Incremental ops carry state forward across tests since
  // `applyAddOrChange` doesn't observe the disk wipe — without this reset,
  // a later test sees lingering notes from earlier ones.
  await indexStore.buildIndex();
});

async function writeNote(rel: string, body: string): Promise<void> {
  const full = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body, "utf8");
}

// =============================================================================
// parseAllFrontmatter
// =============================================================================

test("parseAllFrontmatter: inline scalars with bool/int/float coercion", () => {
  const text = `---
title: My Note
count: 42
ratio: 0.5
active: true
deleted: false
---
Body.`;
  const fm = indexStore.parseAllFrontmatter(text);
  assert.equal(fm.title, "My Note");
  assert.equal(fm.count, 42);
  assert.equal(fm.ratio, 0.5);
  assert.equal(fm.active, true);
  assert.equal(fm.deleted, false);
});

test("parseAllFrontmatter: inline flow array with quoted commas", () => {
  // Reviewer-driven fix in PR-D — array tokenizer must keep "Foo, bar" intact.
  const text = `---
aliases: ["Foo, bar", baz, "with \\"quote\\""]
---`;
  const fm = indexStore.parseAllFrontmatter(text);
  assert.deepEqual(fm.aliases, ["Foo, bar", "baz", 'with "quote"']);
});

test("parseAllFrontmatter: block array", () => {
  const text = `---
tags:
  - alpha
  - bravo
  - charlie
---`;
  const fm = indexStore.parseAllFrontmatter(text);
  assert.deepEqual(fm.tags, ["alpha", "bravo", "charlie"]);
});

test("parseAllFrontmatter: missing frontmatter → empty object", () => {
  assert.deepEqual(indexStore.parseAllFrontmatter("No frontmatter here."), {});
});

test("parseAllFrontmatter: jd-id with dashes in key", () => {
  // 'jd-id' is a top-level key with a dash — the regex must accept it.
  const text = `---
jd-id: "92.05"
---`;
  const fm = indexStore.parseAllFrontmatter(text);
  assert.equal(fm["jd-id"], "92.05");
});

// =============================================================================
// parseOutlinks
// =============================================================================

test("parseOutlinks: bare, alias, and fragment forms", () => {
  const body = `Plain ref: [[Target]].
With alias: [[Target|nice text]].
With fragment: [[Other#Heading]].
With block ref: [[Third#^block-id]].`;
  const out = indexStore.parseOutlinks(body);
  assert.deepEqual(new Set(out), new Set(["Target", "Other", "Third"]));
});

test("parseOutlinks: fenced and inline code stripped", () => {
  const body = `Real ref: [[Real]].
\`\`\`
This is code with [[FencedRef]].
\`\`\`
And \`inline code with [[InlineRef]]\` here.`;
  const out = indexStore.parseOutlinks(body);
  assert.deepEqual(out, ["Real"]);
});

test("parseOutlinks: dedupes repeated targets", () => {
  const body = `[[A]] and [[A]] and [[A|alias]] and [[A#frag]].`;
  const out = indexStore.parseOutlinks(body);
  assert.deepEqual(out, ["A"]);
});

// =============================================================================
// buildIndex + indexStatus
// =============================================================================

test("buildIndex: empty vault → ready with 0 notes", async () => {
  await indexStore.buildIndex();
  const s = indexStore.indexStatus();
  assert.equal(s.status, "ready");
  assert.equal(s.count, 0);
  assert.ok(s.last_built_at, "last_built_at should be set");
});

test("buildIndex: ignores .obsidian/ and other hidden dirs", async () => {
  await writeNote(".obsidian/config.md", "hidden");
  await writeNote(".trash/old.md", "trashed");
  await writeNote("real.md", "real");
  await indexStore.buildIndex();
  assert.equal(indexStore.indexStatus().count, 1);
});

test("buildIndex: duplicate JD-IDs warn but second-wins", async () => {
  // JD id is derived from the filename prefix (filename-canonical). The same id
  // appearing in two folders is a JD-invariant violation we still index second-wins.
  await writeNote("a/99.01 First.md", "A.");
  await writeNote("b/99.01 Second.md", "B.");
  await indexStore.buildIndex();
  // Path-sorted walk means "a/…" is indexed first, "b/…" second. Second wins.
  const r = indexStore.resolveRefs(["99.01"])[0];
  assert.equal(r.path, "b/99.01 Second.md");
  assert.equal(r.matched_by, "jd-id");
});

test("deriveJdIdFromPath: id / project / area / category / none", () => {
  const d = indexStore.deriveJdIdFromPath;
  // id note: "NN.NN <title>"
  assert.equal(d("04 Obsidian tooling/04.18 obsidian-execute-code.md", "04.18 obsidian-execute-code"), "04.18");
  // project note: 5-digit prefix inside an expanded area (90-99)
  assert.equal(d("90-99 Software/92208 Concept note.md", "92208 Concept note"), "92208");
  // expanded *category* (27) also uses 5-digit ids
  assert.equal(d("20-29 People/27 Foo/27001 Bar.md", "27001 Bar"), "27001");
  // fractal / sub-project inside an expanded area
  assert.equal(d("90-99 Software/92004 jd/92004.01 Child.md", "92004.01 Child"), "92004.01");
  // fractal in an expanded *category* (27) is NOT valid — fractal ids are
  // expanded-area-only, matching jd-numbering's parseJdId
  assert.equal(d("20-29 People/27 Foo/27001.10 Bar.md", "27001.10 Bar"), undefined);
  // area folder note: the note is its own folder note, "A0-A9 <title>"
  assert.equal(d("00-09 System/00-09 System.md", "00-09 System"), "00-09");
  // category folder note: "<area>/<NN …>/<NN …>" → "NN.00"
  assert.equal(d("00-09 System/00 System management/00 System management.md", "00 System management"), "00.00");
  // id-level folder note (three-segment folder, "NN.NN …" basename) → "NN.NN", not "NN.00"
  assert.equal(
    d("00-09 System/00 System management/00.05 Agents/00.05 Agents.md", "00.05 Agents"),
    "00.05",
  );
  // 5-digit prefix OUTSIDE an expanded area/category is NOT a JD id
  assert.equal(d("10-19 Personal/10000 Hours.md", "10000 Hours"), undefined);
  // no JD prefix → undefined
  assert.equal(d("some/random note.md", "random note"), undefined);
  // a bare "NN.NN.md" (no title after the id) is not an id note
  assert.equal(d("04.18.md", "04.18"), undefined);
});

// =============================================================================
// resolveRefs
// =============================================================================

test("resolveRefs: exact path (with and without .md)", async () => {
  await writeNote("folder/note.md", "x");
  await indexStore.buildIndex();
  const [withExt, withoutExt] = indexStore.resolveRefs(["folder/note.md", "folder/note"]);
  assert.equal(withExt.path, "folder/note.md");
  assert.equal(withExt.matched_by, "path");
  assert.equal(withoutExt.path, "folder/note.md");
  assert.equal(withoutExt.matched_by, "path");
});

test("resolveRefs: path wins when both a basename-matching file AND a jd-id file exist", async () => {
  // Resolution order is path → jd-id → basename → alias. A file literally
  // named "92.05.md" causes the `working + '.md'` path attempt to hit first,
  // even when another note's filename ("92.05 Real.md") derives jd-id 92.05.
  await writeNote("92.05 Real.md", "A."); // filename-derived jd-id 92.05
  await writeNote("92.05.md", "B.");      // basename equals the JD-ID literally
  await indexStore.buildIndex();
  const r = indexStore.resolveRefs(["92.05"])[0];
  assert.equal(r.path, "92.05.md");
  assert.equal(r.matched_by, "path");
});

test("resolveRefs: basename ambiguous → ambiguous array, no path", async () => {
  await writeNote("a/Note.md", "x");
  await writeNote("b/Note.md", "y");
  await indexStore.buildIndex();
  const r = indexStore.resolveRefs(["Note"])[0];
  assert.equal(r.path, undefined);
  assert.deepEqual(new Set(r.ambiguous), new Set(["a/Note.md", "b/Note.md"]));
});

test("resolveRefs: alias match", async () => {
  await writeNote("real.md", "---\naliases: [Pretty Name]\n---\nx");
  await indexStore.buildIndex();
  const r = indexStore.resolveRefs(["Pretty Name"])[0];
  assert.equal(r.path, "real.md");
  assert.equal(r.matched_by, "alias");
});

test("resolveRefs: [[wrapping]], #fragment, and |alias all parsed and preserved", async () => {
  await writeNote("note.md", "x");
  await indexStore.buildIndex();
  const r = indexStore.resolveRefs(["[[note#Heading|Pretty]]"])[0];
  assert.equal(r.path, "note.md");
  assert.equal(r.matched_by, "path");
  assert.equal(r.alias, "Pretty");
  assert.equal(r.fragment, "Heading");
});

test("resolveRefs: unresolved → no path, no ambiguous", async () => {
  await indexStore.buildIndex();
  const r = indexStore.resolveRefs(["NonExistent"])[0];
  assert.equal(r.path, undefined);
  assert.equal(r.ambiguous, undefined);
});

// =============================================================================
// getBacklinks / getOutlinks
// =============================================================================

test("getBacklinks: simple A→B link", async () => {
  await writeNote("A.md", "Linking to [[B]].");
  await writeNote("B.md", "B is here.");
  await indexStore.buildIndex();
  assert.deepEqual(indexStore.getBacklinks("B.md"), ["A.md"]);
  assert.deepEqual(indexStore.getBacklinks("A.md"), []);
});

test("getOutlinks: resolved and ambiguous_paths separated", async () => {
  await writeNote("X.md", "ref to [[B]] and [[Ambig]]");
  await writeNote("B.md", "B");
  await writeNote("a/Ambig.md", "a");
  await writeNote("b/Ambig.md", "b");
  await indexStore.buildIndex();
  const out = indexStore.getOutlinks("X.md");
  assert.equal(out.length, 2);
  const resolved = out.find((o) => o.ref === "B");
  const ambig = out.find((o) => o.ref === "Ambig");
  assert.equal(resolved?.resolved_path, "B.md");
  assert.deepEqual(new Set(ambig?.ambiguous_paths), new Set(["a/Ambig.md", "b/Ambig.md"]));
});

// =============================================================================
// searchByFrontmatter
// =============================================================================

test("searchByFrontmatter: scalar match", async () => {
  await writeNote("a.md", "---\nstatus: active\n---\nx");
  await writeNote("b.md", "---\nstatus: archived\n---\ny");
  await writeNote("c.md", "---\nstatus: active\n---\nz");
  await indexStore.buildIndex();
  const matches = indexStore.searchByFrontmatter("status", "active");
  assert.deepEqual(new Set(matches.map((m) => m.path)), new Set(["a.md", "c.md"]));
});

test("searchByFrontmatter: array field matches any element", async () => {
  await writeNote("a.md", "---\ntags:\n  - alpha\n  - bravo\n---\nx");
  await writeNote("b.md", "---\ntags:\n  - bravo\n---\ny");
  await writeNote("c.md", "---\ntags:\n  - charlie\n---\nz");
  await indexStore.buildIndex();
  const matches = indexStore.searchByFrontmatter("tags", "bravo");
  assert.deepEqual(new Set(matches.map((m) => m.path)), new Set(["a.md", "b.md"]));
});

test("searchByFrontmatter: case-insensitive property name, case-sensitive value", async () => {
  await writeNote("a.md", "---\nStatus: Active\n---\nx");
  await indexStore.buildIndex();
  // Property 'STATUS' matches 'Status' (case-insensitive).
  assert.equal(indexStore.searchByFrontmatter("STATUS", "Active").length, 1);
  // Value 'active' (lowercase) does NOT match 'Active' (exact only).
  assert.equal(indexStore.searchByFrontmatter("Status", "active").length, 0);
});

// =============================================================================
// Incremental updates (applyAddOrChange / applyUnlink) — #23
// =============================================================================

function abs(rel: string): string {
  return path.join(tmpRoot, rel);
}

test("applyAddOrChange: new file lands in every forward map + backlinks", async () => {
  await writeNote("A.md", "Linking to [[B]].");
  await writeNote("B.md", "B.");
  await indexStore.buildIndex(); // start with empty-then-pop-A-and-B
  // Reset to a known empty state via a rebuild, then apply incrementally.
  await fs.rm(abs("A.md"));
  await fs.rm(abs("B.md"));
  await indexStore.buildIndex();
  assert.equal(indexStore.indexStatus().count, 0);

  // Now apply via incremental ops, simulating chokidar add events.
  await writeNote("92.05 A.md", "---\naliases: [Alpha]\n---\nLinking to [[B]].");
  await writeNote("B.md", "B.");
  await indexStore.applyAddOrChange(abs("92.05 A.md"));
  await indexStore.applyAddOrChange(abs("B.md"));

  assert.equal(indexStore.indexStatus().count, 2);
  assert.equal(indexStore.resolveRefs(["Alpha"])[0].path, "92.05 A.md");
  assert.equal(indexStore.resolveRefs(["92.05"])[0].path, "92.05 A.md");
  assert.deepEqual(indexStore.getBacklinks("B.md"), ["92.05 A.md"]);
});

test("applyAddOrChange: equivalent to buildIndex on the same disk state", async () => {
  // Build via incremental, then build via full rebuild, compare every index.
  await writeNote("X.md", "ref to [[Y]] and [[Ambig]]");
  await writeNote("Y.md", "---\naliases: [Yannick]\n---\nY.");
  await writeNote("a/Ambig.md", "x");
  await writeNote("b/Ambig.md", "y");
  await writeNote(
    "99.05 Z.md",
    "---\nstatus: active\ntags:\n  - alpha\n  - bravo\n---\nZ links to [[Y]] too."
  );

  // Path 1: incremental.
  await indexStore.applyAddOrChange(abs("X.md"));
  await indexStore.applyAddOrChange(abs("Y.md"));
  await indexStore.applyAddOrChange(abs("a/Ambig.md"));
  await indexStore.applyAddOrChange(abs("b/Ambig.md"));
  await indexStore.applyAddOrChange(abs("99.05 Z.md"));
  const incCount = indexStore.indexStatus().count;
  const incBacklinks = indexStore.getBacklinks("Y.md");
  const incOutlinks = indexStore.getOutlinks("X.md");
  const incResolveYannick = indexStore.resolveRefs(["Yannick"])[0];
  const incResolveJdid = indexStore.resolveRefs(["99.05"])[0];
  const incFmActive = indexStore
    .searchByFrontmatter("status", "active")
    .map((n) => n.path)
    .sort();
  const incFmBravo = indexStore
    .searchByFrontmatter("tags", "bravo")
    .map((n) => n.path)
    .sort();

  // Path 2: full rebuild on same disk state.
  await indexStore.buildIndex();
  const fullCount = indexStore.indexStatus().count;
  const fullBacklinks = indexStore.getBacklinks("Y.md");
  const fullOutlinks = indexStore.getOutlinks("X.md");
  const fullResolveYannick = indexStore.resolveRefs(["Yannick"])[0];
  const fullResolveJdid = indexStore.resolveRefs(["99.05"])[0];
  const fullFmActive = indexStore
    .searchByFrontmatter("status", "active")
    .map((n) => n.path)
    .sort();
  const fullFmBravo = indexStore
    .searchByFrontmatter("tags", "bravo")
    .map((n) => n.path)
    .sort();

  assert.equal(incCount, fullCount);
  assert.deepEqual(new Set(incBacklinks), new Set(fullBacklinks));
  // Outlinks ordering depends on parse — compare as sets of (ref, resolved/ambig).
  const norm = (entries: ReturnType<typeof indexStore.getOutlinks>) =>
    entries
      .map((e) => ({
        ref: e.ref,
        resolved: e.resolved_path,
        ambig: e.ambiguous_paths ? [...e.ambiguous_paths].sort() : undefined,
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref));
  assert.deepEqual(norm(incOutlinks), norm(fullOutlinks));
  assert.deepEqual(incResolveYannick, fullResolveYannick);
  assert.deepEqual(incResolveJdid, fullResolveJdid);
  assert.deepEqual(incFmActive, fullFmActive);
  assert.deepEqual(incFmBravo, fullFmBravo);
});

test("applyAddOrChange: change-that-removes-an-outlink prunes backlinks", async () => {
  await writeNote("A.md", "Linking to [[B]] and [[C]].");
  await writeNote("B.md", "B.");
  await writeNote("C.md", "C.");
  await indexStore.buildIndex();
  assert.deepEqual(indexStore.getBacklinks("B.md"), ["A.md"]);
  assert.deepEqual(indexStore.getBacklinks("C.md"), ["A.md"]);

  // Rewrite A to drop the link to B.
  await fs.writeFile(abs("A.md"), "Linking only to [[C]].", "utf8");
  await indexStore.applyAddOrChange(abs("A.md"));

  assert.deepEqual(indexStore.getBacklinks("B.md"), []);
  assert.deepEqual(indexStore.getBacklinks("C.md"), ["A.md"]);
});

test("applyAddOrChange: change that removes an alias prunes byAlias", async () => {
  await writeNote("note.md", "---\naliases: [Old, Keep]\n---\nx");
  await indexStore.buildIndex();
  assert.equal(indexStore.resolveRefs(["Old"])[0].path, "note.md");
  assert.equal(indexStore.resolveRefs(["Keep"])[0].path, "note.md");

  // Drop Old alias.
  await fs.writeFile(abs("note.md"), "---\naliases: [Keep]\n---\nx", "utf8");
  await indexStore.applyAddOrChange(abs("note.md"));

  assert.equal(indexStore.resolveRefs(["Old"])[0].path, undefined);
  assert.equal(indexStore.resolveRefs(["Keep"])[0].path, "note.md");
});

test("applyUnlink: drops note from forward maps + backlinks-to and clears backlinks-of", async () => {
  await writeNote("A.md", "ref to [[B]]");
  await writeNote("B.md", "B has its own ref to [[A]]");
  await indexStore.buildIndex();
  assert.deepEqual(indexStore.getBacklinks("B.md"), ["A.md"]);
  assert.deepEqual(indexStore.getBacklinks("A.md"), ["B.md"]);

  await fs.rm(abs("A.md"));
  await indexStore.applyUnlink(abs("A.md"));

  // A is gone from byPath.
  assert.equal(indexStore.resolveRefs(["A"])[0].path, undefined);
  // A no longer outlinks to B, so B's backlinks are empty.
  assert.deepEqual(indexStore.getBacklinks("B.md"), []);
  // A is deleted, so backlinks[A.md] is cleared even though B still wikilinks
  // to A on disk — matches what a fresh rebuild would produce since A is no
  // longer in byPath and resolve fails during the rebuild's outlink pass.
  assert.deepEqual(indexStore.getBacklinks("A.md"), []);
  assert.equal(indexStore.indexStatus().count, 1);
});

test("applyUnlink: no-op for a path that was never indexed", async () => {
  await indexStore.buildIndex();
  await indexStore.applyUnlink(abs("never-existed.md"));
  assert.equal(indexStore.indexStatus().count, 0);
});

test("applyAddOrChange: nonexistent file is a no-op (handles event for unlinked-in-window file)", async () => {
  await writeNote("present.md", "x");
  await indexStore.buildIndex();
  await indexStore.applyAddOrChange(abs("vanished.md"));
  assert.equal(indexStore.indexStatus().count, 1);
});

test("applyAddOrChange: updates last_built_at", async () => {
  await indexStore.buildIndex();
  const t0 = indexStore.indexStatus().last_built_at!;
  await writeNote("fresh.md", "x");
  // Sleep 5ms to guarantee a strictly later ISO timestamp.
  await new Promise((r) => setTimeout(r, 5));
  await indexStore.applyAddOrChange(abs("fresh.md"));
  const t1 = indexStore.indexStatus().last_built_at!;
  assert.ok(t1 > t0, `last_built_at should advance: ${t0} → ${t1}`);
});

test("applyAddOrChange: 'change' event for a never-indexed file is treated as 'add'", async () => {
  // Real-world race: obsidian-sync drops a file, chokidar fires 'change'
  // before the watcher sees the 'add' (or the path was filtered earlier and
  // a later change re-introduces it). doApplyAddOrChange falls through the
  // byPath miss into the add path. Test it works.
  await writeNote("late.md", "---\naliases: [Late Riser]\n---\nLate body.");
  // No buildIndex here — beforeEach already gave us an empty-state index.
  await indexStore.applyAddOrChange(abs("late.md"));
  assert.equal(indexStore.indexStatus().count, 1);
  assert.equal(indexStore.resolveRefs(["Late Riser"])[0].path, "late.md");
});

test("getBacklinks order matches buildIndex order after incremental ops", async () => {
  // backlinks list ordering should be deterministic across the two paths:
  // adding A, B, C linking to T → backlinks[T] should be [A, B, C] in path
  // order, same as a fresh rebuild would produce. The fix sorts state.notes
  // by path inside recomputeAllBacklinks.
  await writeNote("T.md", "T body.");
  await writeNote("B.md", "links to [[T]]");
  await writeNote("A.md", "links to [[T]]");
  await writeNote("C.md", "links to [[T]]");
  // Apply in a NON-path-sorted order to make sure recompute re-sorts.
  await indexStore.applyAddOrChange(abs("T.md"));
  await indexStore.applyAddOrChange(abs("B.md"));
  await indexStore.applyAddOrChange(abs("A.md"));
  await indexStore.applyAddOrChange(abs("C.md"));
  const incremental = indexStore.getBacklinks("T.md");

  await indexStore.buildIndex();
  const full = indexStore.getBacklinks("T.md");

  // Exact-order equality, not Set equality — catches the sort-order regression
  // the reviewer flagged.
  assert.deepEqual(incremental, full);
  assert.deepEqual(incremental, ["A.md", "B.md", "C.md"]);
});

test("applyAddOrChange: duplicate jd-id is accepted; second-wins like full rebuild", async () => {
  await writeNote("a/77.07 First.md", "first");
  await indexStore.buildIndex();
  assert.equal(indexStore.resolveRefs(["77.07"])[0].path, "a/77.07 First.md");

  // A second file in another folder derives the same jd-id incrementally.
  await writeNote("b/77.07 Second.md", "second");
  await indexStore.applyAddOrChange(abs("b/77.07 Second.md"));

  // Second-wins: the lexically-later path ("b/…") overrides the earlier winner.
  assert.equal(indexStore.resolveRefs(["77.07"])[0].path, "b/77.07 Second.md");
});

// =============================================================================
// Issue #27 — unquoted numeric jd-ids with leading zeros (#27)
// =============================================================================

test("#27 parseAllFrontmatter: unquoted jd-id with leading zero stays a string", () => {
  // coerceScalar must not parse "03.05" as the float 3.05.
  const text = `---\njd-id: 03.05\n---\nBody.`;
  const fm = indexStore.parseAllFrontmatter(text);
  assert.equal(fm["jd-id"], "03.05", 'jd-id should remain "03.05", not become 3.05');
});

test("#27 resolveRefs: leading-zero jd-id 03.05 is resolvable by the string '03.05'", async () => {
  // Filename-canonical: the id derives from the "03.05" filename prefix, and the
  // leading zero must survive (never coerced to the float 3.05).
  await writeNote("03.05 Agents.md", "Body.");
  await indexStore.buildIndex();
  const r = indexStore.resolveRefs(["03.05"])[0];
  assert.equal(r.path, "03.05 Agents.md");
  assert.equal(r.matched_by, "jd-id");
});

test("#27 searchByFrontmatter: unquoted jd-id 03.05 findable by string value '03.05'", async () => {
  await writeNote("slot.md", "---\njd-id: 03.05\n---\nBody.");
  await indexStore.buildIndex();
  const matches = indexStore.searchByFrontmatter("jd-id", "03.05");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, "slot.md");
});

// =============================================================================
// Issue #28 — deterministic duplicate-jd-id winner across incremental + rebuild
// =============================================================================

test("#28 duplicate jd-id: incremental re-add of loser doesn't override winner", async () => {
  // "a/…" < "b/…" lexically → buildIndex processes a first, b last → b wins.
  await writeNote("a/55.01 A.md", "A");
  await writeNote("b/55.01 B.md", "B");
  await indexStore.buildIndex();
  assert.equal(
    indexStore.resolveRefs(["55.01"])[0].path,
    "b/55.01 B.md",
    "full rebuild: b/… (sorted-last) should win",
  );

  // Incrementally re-apply the loser (a/…). The winner (b/…) must not change.
  await indexStore.applyAddOrChange(abs("a/55.01 A.md"));
  assert.equal(
    indexStore.resolveRefs(["55.01"])[0].path,
    "b/55.01 B.md",
    "after incremental re-add of loser, b/… must still win",
  );
});
