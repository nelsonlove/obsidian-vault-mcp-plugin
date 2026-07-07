import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMoves, okError } from "../src/mcp/helpers.ts";

test("validateMoves allows disjoint moves", () => {
  const result = validateMoves([
    { from: "Inbox/A.md", to: "Archive/A.md" },
    { from: "Inbox/B.md", to: "Archive/B.md" },
  ]);
  assert.equal(result, null);
});

test("validateMoves rejects a duplicate source", () => {
  const result = validateMoves([
    { from: "Inbox/A.md", to: "Archive/A.md" },
    { from: "Inbox/A.md", to: "Archive/B.md" },
  ]);
  assert.ok(result?.includes("Inbox/A.md"));
});

test("validateMoves rejects a duplicate destination", () => {
  const result = validateMoves([
    { from: "Inbox/A.md", to: "Archive/X.md" },
    { from: "Inbox/B.md", to: "Archive/X.md" },
  ]);
  assert.ok(result?.includes("Archive/X.md"));
});

test("validateMoves rejects a swap (path both source and destination)", () => {
  const result = validateMoves([
    { from: "Notes/A.md", to: "Notes/B.md" },
    { from: "Notes/B.md", to: "Notes/A.md" },
  ]);
  assert.ok(result);
});

test("validateMoves rejects a chain (one item's to is another's from)", () => {
  const result = validateMoves([
    { from: "Notes/A.md", to: "Notes/B.md" },
    { from: "Notes/B.md", to: "Notes/C.md" },
  ]);
  assert.ok(result?.includes("Notes/B.md"));
});

test("validateMoves normalizes before comparing — './' alias duplicate destination", () => {
  const result = validateMoves([
    { from: "Notes/A.md", to: "Notes/./X.md" },
    { from: "Notes/B.md", to: "Notes/X.md" },
  ]);
  assert.ok(result?.includes("duplicate destination"));
});

test("validateMoves normalizes before comparing — '..' alias swap", () => {
  const result = validateMoves([
    { from: "Notes/A.md", to: "Notes/B.md" },
    { from: "Notes/sub/../B.md", to: "Notes/C.md" },
  ]);
  assert.ok(result?.includes("both a source and a destination"));
});

test("validateMoves reports an identity item precisely, not as a swap/chain", () => {
  const result = validateMoves([
    { from: "Notes/A.md", to: "Notes/B.md" },
    { from: "Notes/same.md", to: "Notes/same.md" },
  ]);
  assert.ok(result?.includes("same path"));
  assert.ok(result?.includes("Notes/same.md"));
});

test("validateMoves catches a normalized identity item", () => {
  const result = validateMoves([{ from: "Notes/./same.md", to: "Notes/same.md" }]);
  assert.ok(result?.includes("same path"));
});

test("validateMoves rejects a non-.md source with the offending path", () => {
  const result = validateMoves([{ from: "attachments/photo.png", to: "Notes/photo.md" }]);
  assert.ok(result?.includes("source must end in .md"));
  assert.ok(result?.includes("photo.png"));
});

test("validateMoves rejects a non-.md destination with the offending path", () => {
  const result = validateMoves([{ from: "Notes/A.md", to: "Notes/A.txt" }]);
  assert.ok(result?.includes("destination must end in .md"));
  assert.ok(result?.includes("A.txt"));
});

test("okError carries ok()'s shape plus the MCP error flag", () => {
  const result = okError({ count: 0 });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { count: 0 });
  assert.ok(result.content[0].text.includes('"count": 0'));
});
