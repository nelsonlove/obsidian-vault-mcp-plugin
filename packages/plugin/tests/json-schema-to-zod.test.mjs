import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonSchemaToZodShape } from "../src/mcp/json-schema-to-zod.ts";

test("undefined schema yields empty shape", () => {
  assert.deepEqual(jsonSchemaToZodShape(undefined), {});
});

test("required string parses; missing required fails", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { path: { type: "string", description: "a path" } },
    required: ["path"],
  });
  assert.equal(shape.path.safeParse("x.md").success, true);
  assert.equal(shape.path.safeParse(undefined).success, false);
  assert.equal(shape.path.description, "a path");
});

test("non-required properties are optional", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { limit: { type: "integer" } },
  });
  assert.equal(shape.limit.safeParse(undefined).success, true);
  assert.equal(shape.limit.safeParse(5).success, true);
  assert.equal(shape.limit.safeParse(5.5).success, false); // integer, not number
});

test("primitive types validate", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: {
      n: { type: "number" },
      b: { type: "boolean" },
      e: { type: "string", enum: ["a", "b"] },
      arr: { type: "array", items: { type: "string" } },
    },
    required: ["n", "b", "e", "arr"],
  });
  assert.equal(shape.n.safeParse(1.5).success, true);
  assert.equal(shape.b.safeParse(true).success, true);
  assert.equal(shape.e.safeParse("a").success, true);
  assert.equal(shape.e.safeParse("c").success, false);
  assert.equal(shape.arr.safeParse(["x"]).success, true);
  assert.equal(shape.arr.safeParse([1]).success, false);
});

test("unknown/exotic types degrade to accept-anything, never throw", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { weird: { type: "object" }, mystery: {} },
    required: ["weird", "mystery"],
  });
  assert.equal(shape.weird.safeParse({ a: 1 }).success, true);
  assert.equal(shape.mystery.safeParse("anything").success, true);
});

// ── F2: robustness against malformed / dangerous schemas ──────────────────

test("F2: null property value degrades to accept-anything (z.unknown)", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { a: null },
    required: ["a"],
  });
  assert.equal(shape.a.safeParse("anything").success, true);
  assert.equal(shape.a.safeParse(null).success, true);
  assert.equal(shape.a.safeParse(undefined).success, true);
});

test("F2: cyclic items (items === self) returns without throwing", () => {
  const a = { type: "array" };
  a.items = a; // cyclic
  const schema = { type: "object", properties: { arr: a }, required: ["arr"] };
  // Must not throw / stack-overflow regardless of result shape.
  let shape;
  assert.doesNotThrow(() => { shape = jsonSchemaToZodShape(schema); });
  // shape.arr is a ZodType (depth-capped nested array) — just verify it exists.
  assert.ok(shape.arr, "shape.arr should be a ZodType");
});

test("F2: enum with non-string entries (e.g. numbers) degrades to z.unknown", () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { code: { enum: [1, 2, 3] } },
    required: ["code"],
  });
  // z.unknown() accepts anything
  assert.equal(shape.code.safeParse(1).success, true);
  assert.equal(shape.code.safeParse("anything").success, true);
});
