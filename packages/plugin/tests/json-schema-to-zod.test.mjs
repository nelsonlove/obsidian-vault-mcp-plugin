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
