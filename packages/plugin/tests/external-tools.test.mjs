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

test("registration is atomic: a mid-array validation failure registers nothing", () => {
  const reg = new ExternalToolRegistry();
  assert.throws(() => reg.registerTools("p", [spec("valid_tool"), spec("Bad-Name")]), TypeError);
  assert.equal(reg.entries().length, 0);
});

// ── registerExternalTools integration tests ────────────────────────────────

import { registerExternalTools } from "../src/mcp/external-tools.ts";

// Minimal stubs: a fake McpServer capturing registerTool calls, a fake App
// whose plugins map controls the stale-owner check.
function fakeServer() {
  const calls = [];
  return { calls, registerTool: (name, def, handler) => calls.push({ name, def, handler }) };
}
const fakeApp = (loadedIds) => ({ plugins: { plugins: Object.fromEntries(loadedIds.map((i) => [i, {}])) } });

test("external tools register namespaced with restrictive-default annotations", () => {
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["jd-survey"]), [
    { ownerId: "jd-survey", toolName: "jd_survey_x", spec: spec("x") },
    { ownerId: "jd-survey", toolName: "jd_survey_ro", spec: spec("ro", { annotations: { readOnlyHint: true } }) },
  ]);
  assert.equal(server.calls[0].name, "jd_survey_x");
  assert.equal(server.calls[0].def.annotations.readOnlyHint, false); // mutating by default
  assert.equal(server.calls[1].def.annotations.readOnlyHint, true);
});

test("handler result is wrapped in ok(); throw becomes fail()", async () => {
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), [
    { ownerId: "p", toolName: "p_good", spec: spec("good", { handler: async () => ({ n: 7 }) }) },
    { ownerId: "p", toolName: "p_bad", spec: spec("bad", { handler: () => { throw new Error("boom"); } }) },
  ]);
  const good = await server.calls[0].handler({});
  assert.deepEqual(good.structuredContent, { n: 7 });
  assert.equal(good.isError, undefined);
  const bad = await server.calls[1].handler({});
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /boom/);
});

test("stale owner (publisher unloaded) fails cleanly without invoking the handler", async () => {
  const server = fakeServer();
  let invoked = false;
  registerExternalTools(server, fakeApp([]), [
    { ownerId: "gone", toolName: "gone_t", spec: spec("t", { handler: () => { invoked = true; } }) },
  ]);
  const res = await server.calls[0].handler({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no longer loaded/);
  assert.equal(invoked, false);
});
