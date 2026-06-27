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
