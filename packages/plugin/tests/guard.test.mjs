import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPaths, guardCall } from "../src/guard.ts";

// collectPaths gathers path, from, to, and paths[]
test("collectPaths gathers path, from, to", () => {
  const result = collectPaths({ path: "Notes/foo.md", from: "Notes/bar.md", to: "Archive/foo.md" });
  assert.deepEqual(result, ["Notes/foo.md", "Notes/bar.md", "Archive/foo.md"]);
});

test("collectPaths gathers paths[] array", () => {
  const result = collectPaths({ paths: ["a.md", "b.md", 42] });
  assert.deepEqual(result, ["a.md", "b.md"]);
});

// read-only mode
test("read-only blocks a mutating call", () => {
  const blocked = guardCall({ isMutating: true, args: {}, settings: { readOnly: true, allowlist: [] } });
  assert.ok(blocked);
  assert.equal(blocked.code, "read_only");
});

test("read-only allows a read-only call", () => {
  const result = guardCall({ isMutating: false, args: {}, settings: { readOnly: true, allowlist: [] } });
  assert.equal(result, null);
});

// allowlist
test("allowlist blocks an out-of-prefix path", () => {
  const blocked = guardCall({
    isMutating: false,
    args: { path: "Private/secret.md" },
    settings: { readOnly: false, allowlist: ["Notes", "Archive"] },
  });
  assert.ok(blocked);
  assert.equal(blocked.code, "out_of_allowlist");
  assert.ok(blocked.message.includes("Private/secret.md"));
});

test("allowlist allows an in-prefix path", () => {
  const result = guardCall({
    isMutating: false,
    args: { path: "Notes/project.md" },
    settings: { readOnly: false, allowlist: ["Notes"] },
  });
  assert.equal(result, null);
});

test("allowlist allows an exact-prefix match", () => {
  const result = guardCall({
    isMutating: false,
    args: { path: "Notes" },
    settings: { readOnly: false, allowlist: ["Notes"] },
  });
  assert.equal(result, null);
});

test("empty allowlist allows all paths", () => {
  const result = guardCall({
    isMutating: false,
    args: { path: "Anywhere/file.md" },
    settings: { readOnly: false, allowlist: [] },
  });
  assert.equal(result, null);
});

test("allowlist blocks a '..' traversal that resolves outside the allowed prefix", () => {
  const result = guardCall({
    isMutating: false,
    args: { path: "20-29 People/../00-09 System/secret.md" },
    settings: { readOnly: false, allowlist: ["20-29 People"] },
  });
  assert.equal(result?.code, "out_of_allowlist");
});

test("allowlist allows a '..' that stays within the prefix after normalization", () => {
  const result = guardCall({
    isMutating: false,
    args: { path: "20-29 People/26 Divorce/../26 Divorce/note.md" },
    settings: { readOnly: false, allowlist: ["20-29 People"] },
  });
  assert.equal(result, null);
});

// moves[] (batch move tool)
test("collectPaths gathers moves[] from/to pairs", () => {
  const result = collectPaths({
    moves: [
      { from: "Inbox/A.md", to: "Archive/A.md" },
      { from: "Inbox/B.md", to: "Archive/B.md" },
    ],
  });
  assert.deepEqual(result, ["Inbox/A.md", "Archive/A.md", "Inbox/B.md", "Archive/B.md"]);
});

test("collectPaths ignores non-object and non-string entries in moves[]", () => {
  const result = collectPaths({
    moves: [null, 42, { from: "ok.md", to: 7 }, { from: "", to: "also-ok.md" }],
  });
  assert.deepEqual(result, ["ok.md", "also-ok.md"]);
});

test("allowlist blocks an out-of-prefix moves[] destination", () => {
  const blocked = guardCall({
    isMutating: true,
    args: { moves: [{ from: "Notes/a.md", to: "Private/a.md" }] },
    settings: { readOnly: false, allowlist: ["Notes"] },
  });
  assert.ok(blocked);
  assert.equal(blocked.code, "out_of_allowlist");
  assert.ok(blocked.message.includes("Private/a.md"));
});

test("allowlist blocks a traversal path inside moves[]", () => {
  const blocked = guardCall({
    isMutating: true,
    args: { moves: [{ from: "Notes/a.md", to: "Notes/../Private/a.md" }] },
    settings: { readOnly: false, allowlist: ["Notes"] },
  });
  assert.ok(blocked);
  assert.equal(blocked.code, "out_of_allowlist");
});

test("allowlist allows in-prefix moves[]", () => {
  const result = guardCall({
    isMutating: true,
    args: { moves: [{ from: "Notes/a.md", to: "Notes/sub/a.md" }] },
    settings: { readOnly: false, allowlist: ["Notes"] },
  });
  assert.equal(result, null);
});

// ── #18: recursive collection — no bespoke clause per nesting shape ───────────

test("collectPaths finds path-keyed strings at any depth (#18)", () => {
  const result = collectPaths({
    batch: { items: [{ path: "Deep/a.md" }, { nested: { from: "Deep/b.md", to: "Deep/c.md" } }] },
  });
  assert.deepEqual(result.sort(), ["Deep/a.md", "Deep/b.md", "Deep/c.md"]);
});

test("collectPaths finds paths[] arrays at any depth (#18)", () => {
  const result = collectPaths({ query: { paths: ["x.md", "y.md"] } });
  assert.deepEqual(result.sort(), ["x.md", "y.md"]);
});

test("collectPaths still handles moves[] without a bespoke clause (#18)", () => {
  const result = collectPaths({ moves: [{ from: "m/a.md", to: "m/b.md" }, { from: "m/c.md", to: "m/d.md" }] });
  assert.deepEqual(result.sort(), ["m/a.md", "m/b.md", "m/c.md", "m/d.md"]);
});

test("collectPaths ignores path-like text under non-path keys (#18)", () => {
  const result = collectPaths({ content: "see path: Secret/x.md", query: "from A to B" });
  assert.deepEqual(result, []);
});

test("guardCall blocks a nested out-of-allowlist path (#18 — the silent-bypass gap)", () => {
  const blocked = guardCall({
    isMutating: true,
    args: { batch: [{ path: "Private/secret.md" }] },
    settings: { readOnly: false, allowlist: ["Public"] },
  });
  assert.equal(blocked?.code, "out_of_allowlist");
});
