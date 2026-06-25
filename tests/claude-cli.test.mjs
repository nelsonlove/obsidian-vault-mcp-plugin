import { test } from "node:test";
import assert from "node:assert/strict";
import { findClaudeBinary } from "../src/claude-cli.ts";

test("returns first existing candidate", () => {
  const got = findClaudeBinary({
    candidates: ["/a/claude", "/b/claude", "/c/claude"],
    fileExists: (p) => p === "/b/claude",
  });
  assert.equal(got, "/b/claude");
});

test("returns null when none exist", () => {
  assert.equal(findClaudeBinary({ candidates: ["/x"], fileExists: () => false }), null);
});
