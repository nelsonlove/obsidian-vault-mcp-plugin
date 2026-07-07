// packages/plugin/tests/external-tools.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalToolRegistry, sanitizeOwnerId } from "../src/mcp/external-tools.ts";

const spec = (name, extra = {}) => ({
  name, description: `${name} desc`, handler: async () => ({ ok: 1 }), ...extra,
});

test("sanitizeOwnerId lowercases and collapses non-alphanumerics to _", () => {
  assert.equal(sanitizeOwnerId("jd-survey"), "jd_survey");
  assert.equal(sanitizeOwnerId("My.Weird--Plugin"), "my_weird_plugin");
  assert.equal(sanitizeOwnerId("--edge--"), "edge");
});

test("registerTools namespaces by sanitized owner id", () => {
  const reg = new ExternalToolRegistry();
  reg.registerTools("jd-survey", [spec("survey_slot")]);
  assert.deepEqual(reg.entries().map((e) => e.toolName), ["jd_survey_survey_slot"]);
});

test("invalid tool names and non-function handlers throw", () => {
  const reg = new ExternalToolRegistry();
  assert.throws(() => reg.registerTools("p", [spec("Bad-Name")]), TypeError);
  assert.throws(() => reg.registerTools("p", [spec("1starts_with_digit")]), TypeError);
  assert.throws(() => reg.registerTools("p", [{ ...spec("x"), handler: "nope" }]), TypeError);
  assert.throws(() => reg.registerTools("---", [spec("x")]), TypeError); // owner sanitizes to ""
});

test("re-registering the same name replaces, never throws", () => {
  const reg = new ExternalToolRegistry();
  const h2 = async () => ({ v: 2 });
  reg.registerTools("p", [spec("t")]);
  reg.registerTools("p", [{ ...spec("t"), handler: h2 }]);
  const entries = reg.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].spec.handler, h2);
});

test("disposer removes exactly what it registered; idempotent; spares replacements", () => {
  const reg = new ExternalToolRegistry();
  const dispose1 = reg.registerTools("p", [spec("t")]);
  reg.registerTools("p", [spec("t")]); // replacement entry
  dispose1();                          // must NOT remove the replacement
  assert.equal(reg.entries().length, 1);
  dispose1();                          // idempotent
  assert.equal(reg.entries().length, 1);
  const dispose2 = reg.registerTools("q", [spec("a"), spec("b")]);
  dispose2();
  assert.deepEqual(reg.entries().map((e) => e.toolName), ["p_t"]);
});

test("unregisterTools drops all of an owner's tools by raw id", () => {
  const reg = new ExternalToolRegistry();
  reg.registerTools("jd-survey", [spec("a"), spec("b")]);
  reg.registerTools("other", [spec("c")]);
  reg.unregisterTools("jd-survey");
  assert.deepEqual(reg.entries().map((e) => e.toolName), ["other_c"]);
});
