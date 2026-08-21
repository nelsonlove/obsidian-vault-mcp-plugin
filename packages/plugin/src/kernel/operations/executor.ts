// The SHARED OPERATION EXECUTOR — Gate 0, WP1 (D15, D18).
//
// Every invocation resolves here: MCP tool, Obsidian command, pane gesture,
// automation, internal call, third-party publisher. One boundary, so action
// identity, actor binding, scope derivation, availability, errors and receipt
// semantics are the same wherever a call came in.
//
// WHAT THIS IS NOT, and the restraint is the point:
//
// It is not a second mutation kernel. `Kernel.runMutation` already owns the
// write queue, revision preconditions, idempotency, record immutability,
// advisory-lock disclosure and the write journal, and all of that works. This
// wraps it. Rewriting a working kernel alongside a new architecture is how a
// shipped product breaks; D18 settles the alternative — establish the seam
// first, migrate behind it in risk order.
//
// So WP1 adds exactly three things a caller can observe:
//
//   1. an invocation whose action is not registered is REFUSED, at runtime.
//      The build-time inventory proves what the SOURCE declares; this proves
//      what actually executes. The difference matters for surfaces whose names
//      are computed at runtime — a third-party publisher is precisely the case
//      a source scan cannot see.
//   2. every invocation gets a Governor-derived operation id, actor binding and
//      phase history, whether or not anything durable is written.
//   3. the authority fence is enforced a second time, at invocation. Defence in
//      depth, not redundancy: the build check runs over the declared inventory,
//      this runs over what a caller actually presents.
//
// It claims nothing else. Observations, effects, verification and authority
// links stay EMPTY until WP2 and WP6 build the substrate behind them, because a
// proposal citing an observation that was never captured is worse than one
// citing nothing.

import type { SurfaceKind } from "./action.js";
import { isAgentReachable } from "./surface-binding.js";
import type { ActionRegistry } from "./registry.js";
import {
  OPERATION_PHASES,
  nonAuthoritativeDigest,
  normalizeInputs,
  type OperationOutcome,
  type OperationPhase,
  type OperationV1,
  type OperationActor,
} from "./operation.js";

export { OPERATION_PHASES, OPERATION_OUTCOMES } from "./operation.js";
export type { OperationV1, OperationPhase, OperationOutcome } from "./operation.js";

/** Base for every refusal the executor makes before a handler runs. */
export class OperationRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller named an action, or an action version, that is not registered. */
export class UnregisteredActionError extends OperationRefusedError {
  constructor(action: string, version: number) {
    super(
      "unregistered_action",
      `no registered action '${action}@${version}'. Every invocation resolves to a registered action; ` +
        `register it and bind its surface before it can execute.`
    );
  }
}

/** The surface is not bound, or is bound to a different action. */
export class UnboundSurfaceError extends OperationRefusedError {
  constructor(surfaceId: string, action: string) {
    super(
      "unbound_surface",
      `surface '${surfaceId}' is not bound to action '${action}'. A surface opens onto exactly one action, and a ` +
        `caller cannot borrow another surface's contract.`
    );
  }
}

/** A Governor-only action was invoked through an agent-reachable surface. */
export class AuthoritySurfaceError extends OperationRefusedError {
  constructor(surfaceId: string, kind: SurfaceKind, action: string) {
    super(
      "authority_surface",
      `action '${action}' is Governor-only and cannot be invoked through the agent-reachable surface ` +
        `'${surfaceId}' (${kind}). Governor alone admits or advances standing.`
    );
  }
}

export interface OperationRequest {
  action: string;
  actionVersion: number;
  /**
   * The surface invoking this action.
   *
   * `kind` is a CLAIM, and is used only to describe an invocation whose surface
   * does not resolve — where there is no binding to ask. Whenever a binding
   * does resolve, the REGISTRY's kind wins and the claim is discarded.
   *
   * That distinction is load-bearing rather than pedantic: the authority fence
   * is defined over surface kind, so honouring a caller's claim would let one
   * present `kind: "internal"` for an agent-reachable surface and walk straight
   * through it. Same principle as the actor binding — Governor derives what
   * decides authority; the caller's label is descriptive.
   */
  surface: { kind?: SurfaceKind; id: string };
  inputs: unknown;
  /** Present once sessions exist (WP5); null until then. */
  sessionId?: string | null;
  mandateId?: string | null;
  /** Digest of the effective scope, supplied by the surface that computed it. */
  effectiveScopeDigest?: string;
}

export interface OperationExecutorOpts {
  registry: ActionRegistry;
  /** Governor-derived actor binding. Resolved PER CALL: a client's identity
   * only exists after its handshake, well after the executor is built. */
  actor: () => OperationActor;
  now?: () => number;
  newId?: () => string;
  /**
   * Receives every CLOSED operation, successful or not. A throw here is
   * swallowed — the same rule the write journal already follows: losing
   * observability degrades observability, it never reverses a completed vault
   * operation or costs a caller their result.
   */
  onClose?: (operation: OperationV1) => void;
}

/** Lets a handler record the phases only it can witness. */
export type MarkPhase = (phase: OperationPhase) => void;

export interface OperationExecutor {
  run<T>(
    request: OperationRequest,
    handler: (mark: MarkPhase) => Promise<T>
  ): Promise<{ result: T; operation: OperationV1 }>;
}

let seq = 0;
const EPOCH = Date.now().toString(36);

// PHASES RECORD ONLY WHAT HAPPENED.
//
// The first draft derived the phase set from the action's declared MODE and
// pushed all of it at close time — so a mutation refused before the queue (an
// allowlist refusal, an unresolved uid, a revision conflict, a record refusal,
// a lock cap) closed with an envelope claiming `queued` and `attempted`. That
// is exactly the defect this module's own header warns about: a receipt
// describing work nobody did. And it would have been the COMMON case, since
// refusals are what a guard produces.
//
// A declared mode says what an action MAY do, never what one invocation DID.
// The executor therefore records only the four phases it witnesses itself —
// `received`, `resolved`, `receipt-produced`, `closed` — and the handler marks
// the rest as it reaches them, through the `mark` callback `run` passes it.

/**
 * Coded refusals this repo already emits, mapped to the outcome each means.
 *
 * The wire form is `Error [code]: message` (`codedError` in mcp/guarded.ts and
 * mcp/helpers.ts) — a documented convention, not a heuristic, which is why
 * reading the prefix is legitimate rather than screen-scraping.
 *
 * The distinctions matter to a caller deciding what to do next, and collapsing
 * them all to `refused` would throw away exactly the information that decides
 * it:
 *
 *   conflict   nothing was written; re-read and re-plan
 *   uncertain  the operation was ABANDONED at its deadline and may still land;
 *              re-read before any retry. Calling this one `refused` would be
 *              actively dangerous — it invites a retry that duplicates a write.
 *
 * Anything else stays `refused`, and a handler-level error with no code stays
 * `failed`: an unrecognized error is not evidence of a guard decision.
 */
const CODED_OUTCOMES: Record<string, OperationOutcome> = {
  rev_conflict: "conflict",
  write_timeout: "uncertain",
};

const CODED_ERROR = /^Error \[([a-z_]+)\]:/;

/** The `Error [code]:` code carried by a returned error envelope, if any. */
function codeOf(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
  if (typeof first?.text !== "string") return undefined;
  return CODED_ERROR.exec(first.text)?.[1];
}

/**
 * Read the outcome off a result.
 *
 * Tool handlers report failure by RETURNING `{isError: true}` rather than
 * throwing — the `ok()`/`fail()` convention this repo has used since the
 * beginning. An executor that watched only for exceptions would therefore
 * record every refusal as a success, which is the single most misleading thing
 * an operation record could say.
 */
function outcomeOf(result: unknown): OperationOutcome {
  if (result === null || typeof result !== "object") return "completed";
  if ((result as { isError?: unknown }).isError !== true) return "completed";
  const code = codeOf(result);
  return (code ? CODED_OUTCOMES[code] : undefined) ?? "refused";
}

/** The outcome for a THROWN failure, which the kernel uses for its typed errors. */
function thrownOutcome(error: unknown): OperationOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CODED_OUTCOMES[code]) return CODED_OUTCOMES[code];
  if (typeof code === "string") return "refused";
  return "failed";
}

export function createOperationExecutor(opts: OperationExecutorOpts): OperationExecutor {
  const now = opts.now ?? (() => Date.now());
  const newId = opts.newId ?? (() => `${EPOCH}-${++seq}`);

  /**
   * Append a phase, keeping the record in canonical order and never
   * duplicating one. Marking a phase already recorded is a no-op rather than an
   * error: a handler that re-enters the queue after a late settlement should
   * not have to track what it already said.
   */
  function mark(operation: OperationV1, phase: OperationPhase): void {
    if (operation.phases.some((p) => p.phase === phase)) return;
    operation.phases.push({ phase, at: now() });
    operation.phases.sort((a, b) => OPERATION_PHASES.indexOf(a.phase) - OPERATION_PHASES.indexOf(b.phase));
    operation.phase = operation.phases[operation.phases.length - 1]!.phase;
  }

  const closedOps = new WeakSet<OperationV1>();

  function close(operation: OperationV1, outcome: OperationOutcome): OperationV1 {
    // Re-entrancy guard. Closing twice would emit one operation id to the sink
    // twice, which a consumer counting operations would read as two.
    if (closedOps.has(operation)) return operation;
    closedOps.add(operation);
    mark(operation, "receipt-produced");
    mark(operation, "closed");
    operation.outcome = outcome;
    try {
      opts.onClose?.(operation);
    } catch (e) {
      console.error("[governor] operation sink failed", e);
    }
    return operation;
  }

  return {
    async run(request, handler) {
      // The envelope is built BEFORE the checks, on purpose.
      //
      // The first draft threw the three refusals above envelope construction,
      // so a refused invocation produced no operation record and never reached
      // the sink — while this same file claimed "a failed operation still
      // closes; evidence that only exists when work succeeds is not evidence."
      // The worst case was `AuthoritySurfaceError`: an agent-reachable surface
      // attempting a Governor-only action is the single event a governance
      // system most needs recorded, and it was the one leaving no trace.
      //
      // The action id and version here are what the CALLER CLAIMED. For a
      // refusal that is the right thing to record — the claim is the evidence.
      const operation: OperationV1 = {
        schema: "governor.operation/v1",
        id: newId(),
        action: { id: request.action, version: request.actionVersion },
        // The caller's claim, used only until a binding resolves and replaces
        // it. `mcp` is the conservative default for an unresolved surface: it
        // is agent-reachable, so a refusal record never under-states what was
        // attempted.
        surface: { kind: request.surface.kind ?? "mcp", id: request.surface.id },
        // Derived, never taken from inputs. A caller that sends `actor` or
        // `signer` is ignored here and refused at the registry.
        actor: opts.actor(),
        sessionId: request.sessionId ?? null,
        mandateId: request.mandateId ?? null,
        normalizedInputDigest: nonAuthoritativeDigest(normalizeInputs(request.inputs)),
        effectiveScopeDigest: request.effectiveScopeDigest ?? nonAuthoritativeDigest(""),
        phase: "received",
        phases: [{ phase: "received", at: now() }],
        // Everything below stays empty in WP1. WP2 fills observations and
        // effects; WP6 fills verification, authority and the proposal subject.
        // Empty is the honest value — a plausible-looking one would be a claim.
        observations: [],
        plan: null,
        attemptedEffects: [],
        observedEffects: [],
        verification: [],
        authority: null,
        proposalSubject: null,
        standingTransition: null,
        outcome: null,
        recovery: null,
      };

      const refuse = (error: OperationRefusedError): never => {
        close(operation, "refused");
        throw error;
      };

      const action = opts.registry.get(request.action, request.actionVersion);
      if (!action) refuse(new UnregisteredActionError(request.action, request.actionVersion));

      const binding = opts.registry.binding(request.surface.id);
      if (!binding || binding.action !== action!.id || binding.actionVersion !== action!.version) {
        refuse(new UnboundSurfaceError(request.surface.id, `${request.action}@${request.actionVersion}`));
      }

      // From here the REGISTRY's kind is the truth, and the caller's claim is
      // discarded. The envelope is corrected too, so a record never carries a
      // kind the registry disagrees with.
      operation.surface = { kind: binding!.kind, id: binding!.id };

      // The runtime half of the acceptance fence, decided over what the
      // registry says this surface IS — never over what the caller said it is.
      // Deciding it from the request would make the fence opt-out: a caller
      // presenting `kind: "internal"` for an MCP tool would pass.
      //
      // This is still worth having alongside the build-time check, for the
      // reason that check cannot cover: a third-party publisher's bindings are
      // created at connection time from names that are not in this repository,
      // so no source scan ever sees them.
      if (action!.authority.governorOnly && isAgentReachable(binding!.kind)) {
        refuse(new AuthoritySurfaceError(binding!.id, binding!.kind, action!.id));
      }

      mark(operation, "resolved");

      try {
        // The handler marks the phases only IT can witness — reaching the
        // queue, attempting an effect. The executor never assumes them from a
        // declared mode.
        const result = await handler((phase) => mark(operation, phase));
        close(operation, outcomeOf(result));
        return { result, operation };
      } catch (e) {
        // A failed operation still closes. Evidence that only exists when work
        // succeeds is not evidence.
        close(operation, thrownOutcome(e));
        throw e;
      }
    },
  };
}
