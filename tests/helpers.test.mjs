import { test } from "node:test";
import assert from "node:assert/strict";
import { batchMoveConflicts } from "../src/mcp/helpers.ts";

test("batchMoveConflicts allows disjoint moves", () => {
  const result = batchMoveConflicts([
    { from: "Inbox/A.md", to: "Archive/A.md" },
    { from: "Inbox/B.md", to: "Archive/B.md" },
  ]);
  assert.equal(result, null);
});

test("batchMoveConflicts rejects a duplicate source", () => {
  const result = batchMoveConflicts([
    { from: "Inbox/A.md", to: "Archive/A.md" },
    { from: "Inbox/A.md", to: "Archive/B.md" },
  ]);
  assert.ok(result?.includes("Inbox/A.md"));
});

test("batchMoveConflicts rejects a duplicate destination", () => {
  const result = batchMoveConflicts([
    { from: "Inbox/A.md", to: "Archive/X.md" },
    { from: "Inbox/B.md", to: "Archive/X.md" },
  ]);
  assert.ok(result?.includes("Archive/X.md"));
});

test("batchMoveConflicts rejects a swap (path both source and destination)", () => {
  const result = batchMoveConflicts([
    { from: "Notes/A.md", to: "Notes/B.md" },
    { from: "Notes/B.md", to: "Notes/A.md" },
  ]);
  assert.ok(result);
});

test("batchMoveConflicts rejects a chain (one item's to is another's from)", () => {
  const result = batchMoveConflicts([
    { from: "Notes/A.md", to: "Notes/B.md" },
    { from: "Notes/B.md", to: "Notes/C.md" },
  ]);
  assert.ok(result?.includes("Notes/B.md"));
});
