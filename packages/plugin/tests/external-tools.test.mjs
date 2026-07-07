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

// ── F1: built-in namespace collision ─────────────────────────────────────────

test("F1: owner 'obsidian-read' + name 'note' collides with obsidian_* and throws", () => {
  const reg = new ExternalToolRegistry();
  // sanitizeOwnerId("obsidian-read") = "obsidian_read", toolName = "obsidian_read_note"
  assert.throws(
    () => reg.registerTools("obsidian-read", [spec("note")]),
    (e) => e instanceof TypeError && /obsidian_\*/.test(e.message)
  );
  assert.equal(reg.entries().length, 0);
});

// ── F4: cross-owner clobber via sanitize collisions ───────────────────────────

test("F4: two owners sanitizing to the same id — second registerTools throws, first intact", () => {
  const reg = new ExternalToolRegistry();
  reg.registerTools("my-plugin", [spec("tool")]);
  // "my.plugin" sanitizes to "my_plugin", same as "my-plugin"
  // toolName = "my_plugin_tool" — already owned by "my-plugin"
  assert.throws(
    () => reg.registerTools("my.plugin", [spec("tool")]),
    (e) => e instanceof TypeError && /already published/.test(e.message)
  );
  // First owner's entry is intact
  const entries = reg.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ownerId, "my-plugin");
});

// ── F8: invalid inputSchema ───────────────────────────────────────────────────

test("F8: inputSchema without type:'object' (e.g. a zod schema shape) throws", () => {
  const reg = new ExternalToolRegistry();
  assert.throws(
    () => reg.registerTools("p", [spec("x", { inputSchema: { note: { _def: {} } } })]),
    (e) => e instanceof TypeError && /plain JSON Schema/.test(e.message)
  );
});

// ── registerExternalTools integration tests ────────────────────────────────

import { registerExternalTools } from "../src/mcp/external-tools.ts";

// Minimal stubs: a fake McpServer capturing registerTool calls, a fake App
// whose plugins map controls the stale-owner check, and a fake ServerCtx.
function fakeServer() {
  const calls = [];
  return { calls, registerTool: (name, def, handler) => calls.push({ name, def, handler }) };
}
const fakeApp = (loadedIds) => ({ plugins: { plugins: Object.fromEntries(loadedIds.map((i) => [i, {}])) } });
const fakeCtx = (settings, entries = []) => ({
  getSettings: () => settings,
  getExternalTools: () => entries,
});

test("external tools register namespaced with restrictive-default annotations", () => {
  const server = fakeServer();
  const entries = [
    { ownerId: "jd-survey", toolName: "jd_survey_x", spec: spec("x") },
    { ownerId: "jd-survey", toolName: "jd_survey_ro", spec: spec("ro", { annotations: { readOnlyHint: true } }) },
  ];
  registerExternalTools(server, fakeApp(["jd-survey"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  assert.equal(server.calls[0].name, "jd_survey_x");
  assert.equal(server.calls[0].def.annotations.readOnlyHint, false); // mutating by default
  assert.equal(server.calls[1].def.annotations.readOnlyHint, true);
});

test("handler result is wrapped in ok(); throw becomes fail()", async () => {
  const entries = [
    { ownerId: "p", toolName: "p_good", spec: spec("good", { handler: async () => ({ n: 7 }) }) },
    { ownerId: "p", toolName: "p_bad", spec: spec("bad", { handler: () => { throw new Error("boom"); } }) },
  ];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
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
  const entries = [
    { ownerId: "gone", toolName: "gone_t", spec: spec("t", { handler: () => { invoked = true; } }) },
  ];
  registerExternalTools(server, fakeApp([]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  const res = await server.calls[0].handler({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reloaded or unloaded/);
  assert.equal(invoked, false);
});

// ── F5: handler return normalization ─────────────────────────────────────────

test("F5: undefined return → structuredContent {ok:true}", async () => {
  const entries = [{ ownerId: "p", toolName: "p_t", spec: spec("t", { handler: async () => undefined }) }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  const res = await server.calls[0].handler({});
  assert.deepEqual(res.structuredContent, { ok: true });
  assert.equal(res.isError, undefined);
});

test("F5: string return → structuredContent {result:'hi'}", async () => {
  const entries = [{ ownerId: "p", toolName: "p_t", spec: spec("t", { handler: async () => "hi" }) }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  const res = await server.calls[0].handler({});
  assert.deepEqual(res.structuredContent, { result: "hi" });
});

test("F5: array return → structuredContent {result:[1,2]}", async () => {
  const entries = [{ ownerId: "p", toolName: "p_t", spec: spec("t", { handler: async () => [1, 2] }) }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  const res = await server.calls[0].handler({});
  assert.deepEqual(res.structuredContent, { result: [1, 2] });
});

// ── F6: stale-owner identity check ───────────────────────────────────────────

test("F6: replacing owner object after build → isError mentioning reload", async () => {
  const app = fakeApp(["p"]);
  const entries = [{ ownerId: "p", toolName: "p_t", spec: spec("t") }];
  const server = fakeServer();
  registerExternalTools(server, app, fakeCtx({ readOnly: false, allowlist: [] }, entries));
  // Simulate hot-reload: replace the instance
  app.plugins.plugins["p"] = {};
  const res = await server.calls[0].handler({});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /reloaded or unloaded/);
});

test("F6: unchanged owner instance → succeeds", async () => {
  const app = fakeApp(["p"]);
  const entries = [{ ownerId: "p", toolName: "p_t", spec: spec("t") }];
  const server = fakeServer();
  registerExternalTools(server, app, fakeCtx({ readOnly: false, allowlist: [] }, entries));
  // No change to plugins["p"]
  const res = await server.calls[0].handler({});
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent, { ok: 1 });
});

// ── F7: annotations passthrough ───────────────────────────────────────────────

test("F7: destructiveHint:true overrides RW base and is reflected in registered def", () => {
  const entries = [
    { ownerId: "p", toolName: "p_t", spec: spec("t", { annotations: { destructiveHint: true } }) },
  ];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  assert.deepEqual(server.calls[0].def.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
});

// ── F3: allowlist bypass prevention ──────────────────────────────────────────

test("F3: mutating tool with unrecognized args blocked when allowlist is active", async () => {
  const entries = [{ ownerId: "p", toolName: "p_tool", spec: spec("tool") }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: ["ok"] }, entries));
  const res = await server.calls[0].handler({ note: "x" }); // "note" is not a recognized path key
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /blocked/);
});

test("F3: mutating tool passes when allowlist is empty (no restriction)", async () => {
  const entries = [{ ownerId: "p", toolName: "p_tool", spec: spec("tool") }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries));
  const res = await server.calls[0].handler({ note: "x" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(res.structuredContent, { ok: 1 });
});

test("F3: read-only annotated tool not blocked by allowlist check", async () => {
  const entries = [{ ownerId: "p", toolName: "p_ro", spec: spec("ro", { annotations: { readOnlyHint: true } }) }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: ["ok"] }, entries));
  const res = await server.calls[0].handler({ note: "x" }); // no recognized path key — but read-only: allowed
  assert.equal(res.isError, undefined);
});

test("F3: mutating tool with recognized path arg passes F3 check (guard prefix check separate)", async () => {
  const entries = [{ ownerId: "p", toolName: "p_tool", spec: spec("tool") }];
  const server = fakeServer();
  registerExternalTools(server, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: ["ok"] }, entries));
  const res = await server.calls[0].handler({ path: "anywhere/x.md" }); // recognized path field
  // F3 check passes (path is recognized); guard prefix check not wired in fakeServer
  assert.equal(res.isError, undefined);
});

// ── Backstop: registerTool exceptions must not abort the whole loop ───────────

test("Backstop: registerTool throwing for one entry still registers the others", () => {
  const entries = [
    { ownerId: "p", toolName: "p_a", spec: spec("a") },
    { ownerId: "p", toolName: "p_bad", spec: spec("bad") },
    { ownerId: "p", toolName: "p_c", spec: spec("c") },
  ];
  const registered = [];
  const badServer = {
    registerTool: (name, def, handler) => {
      if (name === "p_bad") throw new Error("sdk rejection");
      registered.push(name);
    },
  };
  // Should not throw
  assert.doesNotThrow(() =>
    registerExternalTools(badServer, fakeApp(["p"]), fakeCtx({ readOnly: false, allowlist: [] }, entries))
  );
  assert.deepEqual(registered, ["p_a", "p_c"]);
});
