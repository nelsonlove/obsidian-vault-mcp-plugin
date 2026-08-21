/**
 * operations-executor.test.mjs — WP1, Gate 0.
 *
 * The action registry says what Governor can do. The EXECUTOR is the single
 * place every invocation goes through to do it — MCP tool, Obsidian command,
 * pane gesture, automation, internal call, third-party publisher, all of them.
 *
 * WP1's job is narrow on purpose. The executor does NOT replace
 * `Kernel.runMutation`, the write queue, the journal, the guard or the
 * allowlist; those already work and rewriting them alongside a new architecture
 * is how a working product breaks. It wraps them, so that from this point on:
 *
 *   • an invocation whose action is not registered is REFUSED at runtime, not
 *     merely flagged by a build-time inventory that a dynamic surface could
 *     sidestep;
 *   • every invocation has a Governor-derived operation id, actor binding and
 *     phase history, whether or not anything durable is written; and
 *   • the authority fence is enforced a second time, at the moment of
 *     invocation, so a binding that somehow reached the runtime without passing
 *     the build check still cannot execute from an agent surface.
 *
 * The last one is defence in depth rather than redundancy. The build-time check
 * runs over the DECLARED inventory; the runtime check runs over what a caller
 * actually presents. A third-party publisher computes its tool names at
 * runtime, so it is exactly the case the static check cannot see.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createActionRegistry } from "../src/kernel/operations/registry.ts";
import {
  createOperationExecutor,
  UnregisteredActionError,
  UnboundSurfaceError,
  AuthoritySurfaceError,
  OPERATION_PHASES,
} from "../src/kernel/operations/executor.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

function readAction(over = {}) {
  return {
    id: "note.read",
    version: 1,
    title: "Read a note",
    postcondition: "Return the exact current bytes of one visible Markdown note.",
    owner: "core",
    distribution: "public-default",
    modes: ["read"],
    changeClasses: [],
    observations: { defaultCapture: "evidence", supportsProposal: false },
    effects: { direct: [], discovered: "none" },
    authority: { governorOnly: false, automaticAdmission: "never" },
    scope: { argumentKeys: ["path"], resolvesAddresses: true, enumeration: "not-applicable", whenScoped: "available" },
    retention: { operation: "ephemeral" },
    inputs: ["path"],
    native: true,
    ...over,
  };
}

function mutateAction(over = {}) {
  return readAction({
    id: "note.append",
    modes: ["proposal-mutation"],
    changeClasses: ["content"],
    effects: { direct: ["target-content"], discovered: "none" },
    retention: { operation: "durable-for-mutation" },
    ...over,
  });
}

function admitAction(over = {}) {
  return readAction({
    id: "authority.admit",
    modes: ["authority"],
    changeClasses: ["authority"],
    authority: { governorOnly: true, automaticAdmission: "never" },
    retention: { operation: "durable" },
    ...over,
  });
}

/** A registry with a read, a mutation and a Governor-only authority action. */
function fixtureRegistry() {
  const registry = createActionRegistry();
  registry.register(readAction());
  registry.register(mutateAction());
  registry.register(admitAction());
  registry.bind({ kind: "mcp", id: "obsidian_read_note", action: "note.read", actionVersion: 1 });
  registry.bind({ kind: "mcp", id: "obsidian_append_note", action: "note.append", actionVersion: 1 });
  registry.bind({ kind: "internal", id: "admission.admit", action: "authority.admit", actionVersion: 1 });
  registry.validate();
  return registry;
}

/** A deterministic executor: fixed clock, counted ids, so operations compare. */
function fixtureExecutor(registry = fixtureRegistry(), over = {}) {
  let n = 0;
  return createOperationExecutor({
    registry,
    now: () => 1_700_000_000_000,
    newId: () => `op-${++n}`,
    actor: () => ({ binding: "conn-1", clientClaim: "claude-code/1.0.0" }),
    ...over,
  });
}

const MCP = { kind: "mcp", id: "obsidian_read_note" };

// ── the refusal that makes the inventory real at runtime ─────────────────────

describe("operation executor — an unregistered action cannot execute", () => {
  test("an unknown action id is refused before the handler runs", async () => {
    const executor = fixtureExecutor();
    let ran = false;
    await assert.rejects(
      () =>
        executor.run(
          { action: "note.mystery", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_mystery" }, inputs: {} },
          async () => {
            ran = true;
          }
        ),
      UnregisteredActionError
    );
    assert.equal(ran, false, "the handler must not run — refusal comes before execution, not after");
  });

  test("a known action at an unknown version is refused", async () => {
    const executor = fixtureExecutor();
    await assert.rejects(
      () => executor.run({ action: "note.read", actionVersion: 9, surface: MCP, inputs: {} }, async () => "x"),
      UnregisteredActionError
    );
  });

  test("a surface the registry does not bind is refused", async () => {
    const executor = fixtureExecutor();
    await assert.rejects(
      () =>
        executor.run(
          { action: "note.read", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_not_bound" }, inputs: {} },
          async () => "x"
        ),
      UnboundSurfaceError
    );
  });

  test("a binding that names a DIFFERENT action than the caller claims is refused", async () => {
    // The surface exists and the action exists, but this pairing does not.
    // Accepting it would let a caller borrow another tool's contract.
    const executor = fixtureExecutor();
    await assert.rejects(
      () =>
        executor.run(
          { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_read_note" }, inputs: {} },
          async () => "x"
        ),
      UnboundSurfaceError
    );
  });
});

// ── the authority fence, enforced again at invocation ────────────────────────

describe("operation executor — the authority fence holds at runtime", () => {
  test("a Governor-only action refuses an agent-reachable surface", async () => {
    // Defence in depth: the build check runs over the DECLARED inventory, this
    // runs over what a caller actually presents. A third-party publisher
    // computes its names at runtime, which is precisely what the static check
    // cannot see.
    const registry = createActionRegistry();
    registry.register(admitAction());
    registry.bind({ kind: "mcp", id: "obsidian_admit", action: "authority.admit", actionVersion: 1 });
    // NOTE: not validated — this is the case where a bad binding reached the
    // runtime anyway. The executor must still refuse it.
    const executor = fixtureExecutor(registry);
    let ran = false;
    await assert.rejects(
      () =>
        executor.run(
          { action: "authority.admit", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_admit" }, inputs: {} },
          async () => {
            ran = true;
          }
        ),
      AuthoritySurfaceError
    );
    assert.equal(ran, false);
  });

  test("the same action runs from an internal surface", async () => {
    const executor = fixtureExecutor();
    const { result } = await executor.run(
      { action: "authority.admit", actionVersion: 1, surface: { kind: "internal", id: "admission.admit" }, inputs: {} },
      async () => "admitted"
    );
    assert.equal(result, "admitted");
  });
});

// ── every invocation becomes an operation ────────────────────────────────────

describe("operation executor — the operation envelope", () => {
  test("a successful read produces a closed operation with Governor-derived identity", async () => {
    const executor = fixtureExecutor();
    const { result, operation } = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: { path: "A.md" } },
      async () => "contents"
    );
    assert.equal(result, "contents");
    assert.equal(operation.schema, "governor.operation/v1");
    assert.equal(operation.id, "op-1");
    assert.deepEqual(operation.action, { id: "note.read", version: 1 });
    assert.deepEqual(operation.surface, MCP);
    assert.equal(operation.outcome, "completed");
    assert.equal(operation.phase, "closed");
  });

  test("actor binding comes from Governor, never from the caller's inputs", async () => {
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      {
        action: "note.read",
        actionVersion: 1,
        surface: MCP,
        // A caller trying to name itself. It must have no effect.
        inputs: { path: "A.md", actor: "somebody-else", signer: "forged" },
      },
      async () => "x"
    );
    assert.equal(operation.actor.binding, "conn-1");
    assert.equal(operation.actor.clientClaim, "claude-code/1.0.0");
  });

  test("the input digest is stable across key order and changes with values", async () => {
    const executor = fixtureExecutor();
    const a = await executor.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: { path: "A.md", x: 1 } }, async () => 1);
    const b = await executor.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: { x: 1, path: "A.md" } }, async () => 1);
    const c = await executor.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: { path: "B.md", x: 1 } }, async () => 1);
    assert.equal(a.operation.normalizedInputDigest, b.operation.normalizedInputDigest);
    assert.notEqual(a.operation.normalizedInputDigest, c.operation.normalizedInputDigest);
  });

  test("the digest does not carry note bodies", async () => {
    // The operation record is metadata. A digest that embedded content would
    // make every operation envelope a copy of the note.
    const executor = fixtureExecutor();
    const body = "SECRET-" + "x".repeat(5000);
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: { path: "A.md", content: body } },
      async () => "ok"
    );
    assert.ok(!JSON.stringify(operation).includes("SECRET-"), "the operation envelope must not embed input content");
  });

  test("phases are recorded in order and only the ones the action needs", async () => {
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: {} },
      async () => "x"
    );
    const seen = operation.phases.map((p) => p.phase);
    // A read closes after producing its result; it never queues or attempts an
    // effect, and the envelope must not pretend otherwise.
    assert.ok(seen.includes("received"));
    assert.ok(seen.includes("resolved"));
    assert.ok(seen.includes("closed"));
    assert.ok(!seen.includes("attempted"), "a read must not claim it attempted an effect");
    assert.ok(!seen.includes("admitted"), "a read must not claim admission");
    // Recorded order matches the canonical order.
    const canonical = OPERATION_PHASES.filter((p) => seen.includes(p));
    assert.deepEqual(seen, canonical);
  });

  test("a mutation whose handler marks nothing claims no effect phases", async () => {
    // This test previously asserted the OPPOSITE — that a mutation's envelope
    // carries `attempted` simply because its action's mode says it may mutate.
    // That is the defect an independent review caught: a declared mode says
    // what an action MAY do, never what one invocation DID, and deriving the
    // envelope from it made every pre-queue refusal claim work nobody did.
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async () => "ok"
    );
    const seen = operation.phases.map((p) => p.phase);
    assert.ok(!seen.includes("attempted"), "nothing marked an attempt, so the envelope must not claim one");
  });
});

// ── failure is recorded, not swallowed ───────────────────────────────────────

describe("operation executor — outcomes", () => {
  test("a thrown handler closes the operation as failed and rethrows", async () => {
    const executor = fixtureExecutor();
    const seen = [];
    const ex = fixtureExecutor(fixtureRegistry(), { onClose: (op) => seen.push(op) });
    await assert.rejects(
      () => ex.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: {} }, async () => {
        throw new Error("boom");
      }),
      /boom/
    );
    assert.equal(seen.length, 1, "a failed operation still closes — evidence must not depend on success");
    assert.equal(seen[0].outcome, "failed");
    assert.equal(seen[0].phase, "closed");
    void executor;
  });

  test("a returned error envelope is recorded as refused, not completed", async () => {
    // Tool handlers report failure by RETURNING `{isError: true}` rather than
    // throwing, so an executor that only watched for exceptions would record
    // every refusal as a success.
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: {} },
      async () => ({ isError: true, content: [{ type: "text", text: "Error [out_of_allowlist]: nope" }] })
    );
    assert.equal(operation.outcome, "refused");
  });

  test("every closed operation is handed to onClose exactly once", async () => {
    const closed = [];
    const executor = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op.id) });
    await executor.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: {} }, async () => "a");
    await executor.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: {} }, async () => "b");
    assert.deepEqual(closed, ["op-1", "op-2"]);
  });

  test("a throwing onClose never costs the caller their result", async () => {
    // Same rule the journal already follows: observability failure degrades
    // observability, it does not reverse a completed vault operation.
    const executor = fixtureExecutor(fixtureRegistry(), {
      onClose: () => {
        throw new Error("sink exploded");
      },
    });
    const { result } = await executor.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: {} }, async () => "kept");
    assert.equal(result, "kept");
  });
});

// ── the executor does not invent evidence ────────────────────────────────────

describe("operation executor — WP1 claims only what it can prove", () => {
  test("no observations, effects, verification or authority are claimed", async () => {
    // WP2 builds the observation and effect substrate. Until then the envelope
    // must show those fields EMPTY rather than plausible-looking, because a
    // proposal that cites an observation which was never captured is worse than
    // one that cites nothing.
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async () => "ok"
    );
    assert.deepEqual(operation.observations, []);
    assert.deepEqual(operation.observedEffects, []);
    assert.deepEqual(operation.verification, []);
    assert.equal(operation.authority, null);
    assert.equal(operation.proposalSubject, null);
    assert.equal(operation.standingTransition, null);
  });
});

// ── the two defects the first draft shipped, now pinned ──────────────────────

describe("operation executor — phases record only what happened", () => {
  test("a mutation REFUSED before the queue claims neither queued nor attempted", async () => {
    // The common case once real refusals flow through: an allowlist refusal, an
    // unresolved uid, a revision conflict, a record refusal, a lock cap. The
    // first draft derived phases from the action's declared MODE and pushed all
    // of them at close, so every one of these closed with an envelope claiming
    // work that never happened.
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async () => ({ isError: true, content: [{ type: "text", text: "Error [out_of_allowlist]: nope" }] })
    );
    const seen = operation.phases.map((p) => p.phase);
    assert.ok(!seen.includes("queued"), "refused before the queue — the envelope must not say it queued");
    assert.ok(!seen.includes("attempted"), "refused before the handler ran — nothing was attempted");
    assert.equal(operation.outcome, "refused");
  });

  test("a mutation that DOES reach the queue records it, because the handler says so", async () => {
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async (mark) => {
        mark("queued");
        mark("attempted");
        return "ok";
      }
    );
    const seen = operation.phases.map((p) => p.phase);
    assert.ok(seen.includes("queued"));
    assert.ok(seen.includes("attempted"));
    // Still in canonical order despite being marked mid-flight.
    const canonical = OPERATION_PHASES.filter((p) => seen.includes(p));
    assert.deepEqual(seen, canonical);
  });

  test("marking the same phase twice does not duplicate it", async () => {
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async (mark) => {
        mark("queued");
        mark("queued");
        return "ok";
      }
    );
    assert.equal(operation.phases.filter((p) => p.phase === "queued").length, 1);
  });
});

describe("operation executor — a refusal leaves evidence", () => {
  for (const [name, request] of [
    ["unregistered action", { action: "note.mystery", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_mystery" }, inputs: {} }],
    ["unbound surface", { action: "note.read", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_not_bound" }, inputs: {} }],
  ]) {
    test(`a ${name} refusal still reaches the sink`, async () => {
      const closed = [];
      const executor = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op) });
      await assert.rejects(() => executor.run(request, async () => "x"));
      assert.equal(closed.length, 1, "a refusal that leaves no record is invisible, which is worse than failed");
      assert.equal(closed[0].outcome, "refused");
      assert.equal(closed[0].phase, "closed");
    });
  }

  test("an authority-fence refusal is recorded — the event most worth an audit trail", async () => {
    const registry = createActionRegistry();
    registry.register(admitAction());
    registry.bind({ kind: "mcp", id: "obsidian_admit", action: "authority.admit", actionVersion: 1 });
    const closed = [];
    const executor = fixtureExecutor(registry, { onClose: (op) => closed.push(op) });
    await assert.rejects(
      () =>
        executor.run(
          { action: "authority.admit", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_admit" }, inputs: {} },
          async () => "x"
        ),
      AuthoritySurfaceError
    );
    assert.equal(closed.length, 1, "an agent surface attempting a Governor-only action must be recorded");
    assert.equal(closed[0].outcome, "refused");
    assert.equal(closed[0].action.id, "authority.admit");
    assert.equal(closed[0].surface.id, "obsidian_admit");
  });
});

describe("operation executor — coded outcomes are not flattened", () => {
  test("a revision conflict is a conflict, not a generic refusal", async () => {
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async () => ({ isError: true, content: [{ type: "text", text: "Error [rev_conflict]: stale" }] })
    );
    assert.equal(operation.outcome, "conflict");
  });

  test("a write timeout is UNCERTAIN, because the write may still land", async () => {
    // The distinction that matters most: calling this `refused` would invite a
    // retry that duplicates a write which actually succeeded.
    const executor = fixtureExecutor();
    const { operation } = await executor.run(
      { action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} },
      async () => ({ isError: true, content: [{ type: "text", text: "Error [write_timeout]: abandoned" }] })
    );
    assert.equal(operation.outcome, "uncertain");
  });

  test("a THROWN typed kernel error is mapped by its code too", async () => {
    const executor = fixtureExecutor();
    class RevConflict extends Error {
      code = "rev_conflict";
    }
    const closed = [];
    const ex = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op) });
    await assert.rejects(
      () =>
        ex.run({ action: "note.append", actionVersion: 1, surface: { kind: "mcp", id: "obsidian_append_note" }, inputs: {} }, async () => {
          throw new RevConflict("stale");
        }),
      RevConflict
    );
    assert.equal(closed[0].outcome, "conflict");
    void executor;
  });

  test("an uncoded thrown error stays `failed` — an unknown error is not a guard decision", async () => {
    const closed = [];
    const ex = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op) });
    await assert.rejects(
      () => ex.run({ action: "note.read", actionVersion: 1, surface: MCP, inputs: {} }, async () => {
        throw new Error("kaboom");
      }),
      /kaboom/
    );
    assert.equal(closed[0].outcome, "failed");
  });
});

describe("operation executor — input normalization", () => {
  test("two keys sharing one object reference is aliasing, not a cycle", async () => {
    // A visited-set that only grows reports `<circular>` for the second key,
    // making the digest depend on object identity rather than value.
    const executor = fixtureExecutor();
    const shared = { k: "v" };
    const aliased = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: { a: shared, b: shared } },
      async () => 1
    );
    const distinct = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: { a: { k: "v" }, b: { k: "v" } } },
      async () => 1
    );
    assert.equal(
      aliased.operation.normalizedInputDigest,
      distinct.operation.normalizedInputDigest,
      "equal values must digest equally whether or not the caller reused a reference"
    );
  });

  test("a genuine cycle is still handled without throwing", async () => {
    const executor = fixtureExecutor();
    const cyclic = { name: "x" };
    cyclic.self = cyclic;
    const { operation } = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: { cyclic } },
      async () => 1
    );
    assert.ok(operation.normalizedInputDigest.startsWith("fnv1a64:"));
  });

  test("distinct Dates do not collapse to one digest", async () => {
    const executor = fixtureExecutor();
    const a = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: { at: new Date("2020-01-01T00:00:00Z") } },
      async () => 1
    );
    const b = await executor.run(
      { action: "note.read", actionVersion: 1, surface: MCP, inputs: { at: new Date("2021-01-01T00:00:00Z") } },
      async () => 1
    );
    assert.notEqual(a.operation.normalizedInputDigest, b.operation.normalizedInputDigest);
  });
});

// ── the fence decides over the registry, not over the caller ─────────────────

describe("operation executor — a caller cannot talk its way past the fence", () => {
  test("claiming `kind: internal` for an agent-reachable surface does not bypass it", async () => {
    // The fence is defined over surface kind. If it honoured the caller's
    // claim it would be opt-out: present `internal` and walk through. Same
    // principle as the actor binding — Governor derives what decides
    // authority, and the caller's label is descriptive only.
    const registry = createActionRegistry();
    registry.register(admitAction());
    registry.bind({ kind: "mcp", id: "obsidian_admit", action: "authority.admit", actionVersion: 1 });
    const executor = fixtureExecutor(registry);
    let ran = false;
    await assert.rejects(
      () =>
        executor.run(
          {
            action: "authority.admit",
            actionVersion: 1,
            // The lie.
            surface: { kind: "internal", id: "obsidian_admit" },
            inputs: {},
          },
          async () => {
            ran = true;
          }
        ),
      AuthoritySurfaceError
    );
    assert.equal(ran, false, "the registry says this surface is mcp; the claim must not override it");
  });

  test("the recorded surface kind is the registry's, not the caller's", async () => {
    const closed = [];
    const executor = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op) });
    await executor.run(
      { action: "note.read", actionVersion: 1, surface: { kind: "internal", id: "obsidian_read_note" }, inputs: {} },
      async () => "x"
    );
    assert.equal(closed[0].surface.kind, "mcp", "a record must not carry a kind the registry disagrees with");
  });

  test("a claim is still recorded when no binding resolves, because there is nothing else to say", async () => {
    const closed = [];
    const executor = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op) });
    await assert.rejects(
      () =>
        executor.run(
          { action: "note.mystery", actionVersion: 1, surface: { kind: "automation", id: "nowhere" }, inputs: {} },
          async () => "x"
        ),
      UnregisteredActionError
    );
    assert.equal(closed[0].surface.kind, "automation");
  });

  test("an omitted kind defaults to the agent-reachable one, so a refusal never under-states", async () => {
    const closed = [];
    const executor = fixtureExecutor(fixtureRegistry(), { onClose: (op) => closed.push(op) });
    await assert.rejects(
      () => executor.run({ action: "note.mystery", actionVersion: 1, surface: { id: "nowhere" }, inputs: {} }, async () => "x"),
      UnregisteredActionError
    );
    assert.equal(closed[0].surface.kind, "mcp");
  });
});
