import { test } from "node:test";
import assert from "node:assert/strict";
import { ok, fail } from "../src/responses.ts";

test("ok returns structuredContent deep-equal to input data", () => {
  const result = ok({ a: 1 });
  assert.deepEqual(result.structuredContent, { a: 1 });
});

test("fail returns isError true with message matching /boom/ in text content", () => {
  const result = fail(new Error("boom"));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /boom/);
});
