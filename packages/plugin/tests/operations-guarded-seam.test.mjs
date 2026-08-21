/**
 * operations-guarded-seam.test.mjs — WP1's wiring, Gate 0.
 *
 * The executor is only worth having if it is actually in the path. This file
 * drives `makeGuarded` — the single interception point every MCP registration
 * passes through — against the REAL per-connection action registry, the one
 * `buildMcpServer` constructs, rather than a fixture.
 *
 * Two properties matter here and neither is provable from the pure executor
 * tests:
 *
 *   1. the seam is INERT without an executor. Every existing test constructs
 *      `makeGuarded` without one, and all of them still pass — but "the tests
 *      pass" is weaker than "the two paths produce the same envelope", so that
 *      equivalence is asserted directly.
 *   2. a tool nobody registered cannot execute. The build-time inventory proves
 *      what this repository's source declares; only this proves what a running
 *      connection will actually let through.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { makeGuarded } from "../src/mcp/guarded.ts";
import { buildMcpActionRegistry } from "../src/kernel/operations/mcp-registry.ts";
import { createOperationExecutor } from "../src/kernel/operations/executor.ts";
import { Kernel, WriteJournal, WriteQueue, IdempotencyStore, LockStore } from "../src/kernel/index.ts";

const ACTOR = { transport: "mcp", client: "claude-code/1.0.0", connection: "conn-1" };
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** A kernel over an in-memory adapter, so mutating calls take the real path —
 * the same construction shape the existing kernel tests use. */
function fixtureKernel() {
  const files = new Map();
  const adapter = {
    files,
    async exists(p) { return files.has(p); },
    async mkdir() {},
    async read(p) { return files.get(p) ?? ""; },
    async write(p, data) { files.set(p, data); },
    async append(p, data) { files.set(p, (files.get(p) ?? "") + data); },
  };
  const journal = new WriteJournal(adapter, "dir/journal", () => new Date("2026-08-20T12:00:00Z"));
  const kernel = new Kernel(
    new WriteQueue(1000),
    journal,
    { uid: () => undefined, rev: () => undefined },
    new IdempotencyStore(),
    new LockStore()
  );
  return { kernel };
}

function seam({ settings = {}, external = [], withExecutor = true, kernel = null } = {}) {
  const guardSettings = { readOnly: false, allowlist: [], ...settings };
  const operations = [];
  const { registry, problems } = buildMcpActionRegistry(external);
  const executor = withExecutor
    ? createOperationExecutor({
        registry,
        actor: () => ({ binding: "conn-1", clientClaim: "claude-code/1.0.0" }),
        onClose: (op) => operations.push(op),
      })
    : null;
  const guarded = makeGuarded({
    getSettings: () => guardSettings,
    kernel,
    actor: () => ACTOR,
    executor,
  });
  return { guarded, operations, problems, registry };
}

// ── the real inventory loads cleanly ─────────────────────────────────────────

describe("guarded seam — the per-connection registry", () => {
  test("the declared MCP inventory validates with no problems", () => {
    const { problems } = seam();
    assert.deepEqual(problems, []);
  });

  test("a third-party publisher's runtime-named tools become real bindings", () => {
    // The reason the registry is per-connection at all: these names are
    // computed from whichever plugins happen to be loaded, so they cannot be
    // declared statically and cannot be scanned out of this repo.
    const { registry, problems } = seam({
      external: [{ name: "acme_do_thing", owner: "acme-plugin", readOnly: false }],
    });
    assert.deepEqual(problems, []);
    const binding = registry.binding("acme_do_thing");
    assert.ok(binding, "the publisher's tool must be bound, not waved through by a weaker check");
    assert.equal(binding.kind, "external");
    const action = registry.get("compat.acme_do_thing", 1);
    assert.equal(action.distribution, "private", "third-party code is never public-profile by default");
    assert.equal(action.effects.discovered, "unbounded", "Governor cannot know another plugin's blast radius");
  });

  test("an untrusted read-only claim is carried through as mutating", () => {
    // The host decides trust; the registry records the host's conclusion. If
    // the registry believed the publisher directly it would inventory a
    // different safety posture than the guard enforces.
    const { registry } = seam({ external: [{ name: "acme_read", owner: "acme-plugin", readOnly: false }] });
    assert.equal(registry.get("compat.acme_read", 1).retention.operation, "durable-for-mutation");
  });
});

// ── a tool nobody registered cannot execute ──────────────────────────────────

describe("guarded seam — an unregistered tool is refused at runtime", () => {
  test("an unknown tool name refuses with a coded envelope and never runs", async () => {
    const { guarded } = seam();
    let ran = false;
    const call = guarded({ title: "rogue", inputSchema: {}, annotations: RO }, async () => {
      ran = true;
      return { content: [] };
    }, "obsidian_rogue_tool");
    const result = await call({}, {});
    assert.equal(ran, false, "the handler must not run");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Error \[unregistered_action\]/);
  });

  test("the refusal is recorded — an invocation nobody registered is worth knowing about", async () => {
    const { guarded, operations } = seam();
    await guarded({ title: "rogue", inputSchema: {}, annotations: RO }, async () => ({ content: [] }), "obsidian_rogue_tool")({}, {});
    assert.equal(operations.length, 1);
    assert.equal(operations[0].outcome, "refused");
    assert.equal(operations[0].surface.id, "obsidian_rogue_tool");
  });

  test("a REAL tool name resolves and runs", async () => {
    const { guarded, operations } = seam();
    const call = guarded({ title: "read", inputSchema: {}, annotations: RO }, async () => ({ content: [{ type: "text", text: "hi" }] }), "obsidian_read_note");
    const result = await call({ path: "A.md" }, {});
    assert.equal(result.content[0].text, "hi");
    assert.equal(operations.length, 1);
    assert.equal(operations[0].action.id, "compat.obsidian_read_note");
    assert.equal(operations[0].outcome, "completed");
  });
});

// ── phases reflect what actually happened on the real path ───────────────────

describe("guarded seam — phases follow the real control flow", () => {
  test("a mutation refused by the allowlist records neither queued nor attempted", async () => {
    // The allowlist refusal happens inside `guardCall`, well before the queue.
    // This is the case the pure executor could only simulate.
    const { kernel } = fixtureKernel();
    const { guarded, operations } = seam({ settings: { allowlist: ["Projects/"] }, kernel });
    const call = guarded({ title: "append", inputSchema: {}, annotations: RW }, async () => ({ content: [] }), "obsidian_append_note");
    const result = await call({ path: "Secrets/keys.md", content: "x" }, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /out_of_allowlist/);
    const seen = operations[0].phases.map((p) => p.phase);
    assert.ok(!seen.includes("queued"), "refused before the queue");
    assert.ok(!seen.includes("attempted"), "the handler never ran");
    assert.equal(operations[0].outcome, "refused");
  });

  test("a mutation that reaches the handler records both", async () => {
    const { kernel } = fixtureKernel();
    const { guarded, operations } = seam({ kernel });
    const call = guarded({ title: "append", inputSchema: {}, annotations: RW }, async () => ({ content: [{ type: "text", text: "ok" }] }), "obsidian_append_note");
    await call({ path: "A.md", content: "x" }, {});
    const seen = operations[0].phases.map((p) => p.phase);
    assert.ok(seen.includes("queued"));
    assert.ok(seen.includes("attempted"));
    assert.equal(operations[0].outcome, "completed");
  });

  test("a read never claims to have queued", async () => {
    const { kernel } = fixtureKernel();
    const { guarded, operations } = seam({ kernel });
    await guarded({ title: "read", inputSchema: {}, annotations: RO }, async () => ({ content: [] }), "obsidian_read_note")({ path: "A.md" }, {});
    const seen = operations[0].phases.map((p) => p.phase);
    assert.ok(!seen.includes("queued"));
    assert.ok(!seen.includes("attempted"));
  });
});

// ── the seam is inert without an executor ────────────────────────────────────

describe("guarded seam — absent executor changes nothing", () => {
  test("the same call produces the same result with and without an executor", async () => {
    const handler = async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] });
    const withExec = seam({ withExecutor: true });
    const without = seam({ withExecutor: false });
    const a = await withExec.guarded({ title: "read", inputSchema: {}, annotations: RO }, handler, "obsidian_read_note")({ path: "A.md" }, {});
    const b = await without.guarded({ title: "read", inputSchema: {}, annotations: RO }, handler, "obsidian_read_note")({ path: "A.md" }, {});
    assert.deepEqual(a, b, "introducing the seam must not change what a caller receives");
    assert.equal(without.operations.length, 0);
  });

  test("an allowlist refusal is byte-identical with and without an executor", async () => {
    const settings = { allowlist: ["Projects/"] };
    const handler = async () => ({ content: [] });
    const a = await seam({ settings, withExecutor: true }).guarded({ title: "read", inputSchema: {}, annotations: RO }, handler, "obsidian_read_note")({ path: "Secrets/k.md" }, {});
    const b = await seam({ settings, withExecutor: false }).guarded({ title: "read", inputSchema: {}, annotations: RO }, handler, "obsidian_read_note")({ path: "Secrets/k.md" }, {});
    assert.deepEqual(a, b);
    assert.equal(a.isError, true);
  });

  test("an UNREGISTERED tool still runs when no executor is present", async () => {
    // The pre-seam contract, preserved exactly. Unit tests and bare embeds
    // construct makeGuarded without an executor and must keep working — which
    // is what makes this seam safe to introduce into a shipped product.
    let ran = false;
    const { guarded } = seam({ withExecutor: false });
    const result = await guarded({ title: "rogue", inputSchema: {}, annotations: RO }, async () => {
      ran = true;
      return { content: [{ type: "text", text: "ok" }] };
    }, "obsidian_rogue_tool")({}, {});
    assert.equal(ran, true);
    assert.equal(result.content[0].text, "ok");
  });
});
