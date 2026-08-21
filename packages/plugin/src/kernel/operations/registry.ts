// The ACTION REGISTRY — Gate 0, WP0.
//
// The canonical, machine-readable owner of what Governor can do. Actions are
// registered, surfaces are bound to them, and `validate()` reports every way
// the result contradicts the architecture. A build consumes the problem list;
// a non-empty list is a build failure, not a warning.
//
// Two properties make this worth having rather than a comment:
//
//   1. It is BIDIRECTIONAL. An action with no door and a door onto no action
//      are both defects, and both are reported. Half an inventory is how a
//      capability comes to exist in source, vanish at runtime, remain in the
//      README, and still look supported.
//   2. It reports EVERY defect in one pass. Throwing on the first fault turns
//      a build fix into N build runs, and the second defect is often the one
//      that explains the first.
//
// Deliberately NOT here: permission. A registered action is not an authorized
// one. Distribution, module enablement, dependency availability, posture,
// scope, session, mandate and verification all still apply at invocation — the
// registry only says the contract exists and which doors open onto it.

import { CAPTURE_LEVELS, RESERVED_IDENTITY_INPUTS, SURFACE_KINDS, actionKey, type ActionDefinition } from "./action.js";
import { isAgentReachable, type SurfaceBinding } from "./surface-binding.js";

export { RESERVED_IDENTITY_INPUTS } from "./action.js";
export type { ActionDefinition } from "./action.js";
export type { SurfaceBinding } from "./surface-binding.js";

/**
 * A stable problem code. Stable because build output, generated projections and
 * the migration register all cite them — a renamed code silently unlinks a
 * documented failure from the thing that emits it.
 */
export type RegistryProblemCode =
  /** Two actions registered at the same id AND version. */
  | "action_id_collision"
  /** Two bindings claiming the same surface identity. */
  | "surface_id_collision"
  /** A binding names an action id nothing registered. */
  | "binding_unknown_action"
  /** A binding names a registered action id at an unregistered version. */
  | "binding_unknown_action_version"
  /** A binding declares a surface kind outside the known set. */
  | "binding_unknown_surface_kind"
  /** A registered action that no surface opens onto. */
  | "action_unbound"
  /** An action declares an unknown capture level. */
  | "unknown_capture_level"
  /** D16: an ephemeral observation may not support a proposal, verification, or admission. */
  | "ephemeral_supports_proposal"
  /** An action that can change authority is bound to an agent-reachable surface. */
  | "authority_agent_surface"
  /** An action whose change classes include `authority` is not marked Governor-only. */
  | "authority_class_not_governor_only"
  /** An action declares an input a caller must never supply. */
  | "caller_supplied_identity"
  /** A compatibility action claims evidence its derivation cannot supply. */
  | "compatibility_overclaim";

export interface RegistryProblem {
  code: RegistryProblemCode;
  /** Human-readable, and required to NAME the action or surface it is about —
   * a problem list you have to grep the source to interpret is not usable
   * build output. */
  message: string;
  /** `id@version` when the problem is about an action. */
  action?: string;
  /** Surface identity when the problem is about a binding. */
  surface?: string;
}

export interface ActionRegistry {
  register(action: ActionDefinition): void;
  bind(binding: SurfaceBinding): void;
  /** Validate and SEAL. Idempotent: repeated calls return the same problems. */
  validate(): RegistryProblem[];
  /** Registered actions, in registration order. */
  actions(): ActionDefinition[];
  /** Bindings, in registration order. */
  bindings(): SurfaceBinding[];
  /** Look up one action. Returns undefined rather than throwing — callers that
   * need a refusal make it themselves, with their own error type. */
  get(id: string, version: number): ActionDefinition | undefined;
  /**
   * Look up one binding by surface id.
   *
   * Indexed rather than scanned. The executor resolves a binding on EVERY
   * invocation — including reads, which previously bypassed the queue and the
   * journal entirely — so a linear scan over the whole binding set would put
   * new fixed cost on the cheapest path in the product.
   */
  binding(surfaceId: string): SurfaceBinding | undefined;
}

export function createActionRegistry(): ActionRegistry {
  const actions = new Map<string, ActionDefinition>();
  /** Registration order, so problem output and generated projections are
   * deterministic rather than Map-insertion-dependent in some future refactor. */
  const actionOrder: string[] = [];
  const bindings: SurfaceBinding[] = [];
  /** Problems found at register/bind time (collisions), kept separate from the
   * ones validate() computes so a duplicate is reported once, at the point it
   * happened, rather than re-derived from a Map that only kept the winner. */
  const eager: RegistryProblem[] = [];
  let sealed: RegistryProblem[] | null = null;

  function refuseIfSealed(what: string): void {
    if (sealed) {
      throw new Error(
        `action registry is sealed: ${what} was attempted after validate(). ` +
          `Registration must complete before validation, or the validated inventory is not the one in use.`
      );
    }
  }

  function register(action: ActionDefinition): void {
    refuseIfSealed(`registering '${action.id}@${action.version}'`);
    const key = actionKey(action.id, action.version);
    if (actions.has(key)) {
      // Keep the FIRST registration. A collision is a build failure either
      // way, and keeping the first makes the downstream problem list describe
      // one coherent registry rather than a half-overwritten one.
      eager.push({
        code: "action_id_collision",
        action: key,
        message: `action '${key}' is registered more than once; an id+version pair names exactly one contract and is never redefined in place`,
      });
      return;
    }
    actions.set(key, action);
    actionOrder.push(key);
  }

  function bind(binding: SurfaceBinding): void {
    refuseIfSealed(`binding surface '${binding.id}'`);
    const clash = bindings.find((b) => b.id === binding.id);
    if (clash) {
      eager.push({
        code: "surface_id_collision",
        surface: binding.id,
        message:
          `surface '${binding.id}' is bound more than once ` +
          `(to '${clash.action}@${clash.actionVersion}' and '${binding.action}@${binding.actionVersion}'); ` +
          `a surface identity opens onto exactly one action`,
      });
      return;
    }
    bindings.push(binding);
  }

  function validate(): RegistryProblem[] {
    if (sealed) return sealed;
    const problems: RegistryProblem[] = [...eager];

    // ── per-action rules ─────────────────────────────────────────────────────
    for (const key of actionOrder) {
      const action = actions.get(key)!;

      if (!CAPTURE_LEVELS.includes(action.observations.defaultCapture)) {
        problems.push({
          code: "unknown_capture_level",
          action: key,
          message: `action '${key}' declares capture level '${action.observations.defaultCapture}', which is not one of ${CAPTURE_LEVELS.join(", ")}`,
        });
      }

      // D16. The rule is one-directional on purpose: `evidence` MAY support a
      // proposal when the action's contract names its retained fields as
      // sufficient, so only `ephemeral` is refused here. Whether a particular
      // evidence record is actually sufficient for a particular predicate is a
      // runtime dependency check (WP2), not something a static registry knows.
      if (action.observations.defaultCapture === "ephemeral" && action.observations.supportsProposal) {
        problems.push({
          code: "ephemeral_supports_proposal",
          action: key,
          message:
            `action '${key}' captures ephemerally but claims its observations support a proposal; ` +
            `an ephemeral observation retains no payload, so nothing dependent on it can be re-checked — ` +
            `re-observe durably instead of promoting it`,
        });
      }

      // Authority class and Governor-only must agree. Checked in this
      // direction (class implies governorOnly) rather than the reverse: an
      // action may legitimately be Governor-only WITHOUT changing authority
      // — internal maintenance work is the obvious case.
      if (action.changeClasses.includes("authority") && !action.authority.governorOnly) {
        problems.push({
          code: "authority_class_not_governor_only",
          action: key,
          message:
            `action '${key}' declares the 'authority' change class but is not marked governorOnly; ` +
            `Governor is the only component that may admit or advance standing`,
        });
      }

      const reserved = action.inputs.filter((i) => (RESERVED_IDENTITY_INPUTS as readonly string[]).includes(i));
      if (reserved.length > 0) {
        problems.push({
          code: "caller_supplied_identity",
          action: key,
          message:
            `action '${key}' declares reserved input(s) ${reserved.map((r) => `'${r}'`).join(", ")}; ` +
            `actor, signer, verifier and standing-ref identity are derived by Governor and can never be supplied by a caller`,
        });
      }

      // A compatibility action is derived from an existing registration by the
      // adapter, which can observe a handler's NAME and annotations and
      // nothing else. It therefore cannot know that reads are replayable or
      // that observations are sufficient to support a proposal, and saying so
      // would launder a guess into evidence (D18).
      if (!action.native) {
        if (action.observations.defaultCapture === "replayable" || action.observations.supportsProposal) {
          problems.push({
            code: "compatibility_overclaim",
            action: key,
            message:
              `compatibility action '${key}' claims replayable capture or proposal support; ` +
              `a derived contract may claim only what the existing implementation already proves — ` +
              `declare the action natively before making that claim`,
          });
        }
        if (action.authority.automaticAdmission !== "never") {
          problems.push({
            code: "compatibility_overclaim",
            action: key,
            message: `compatibility action '${key}' claims mandate eligibility; a derived contract is never mandate-eligible`,
          });
        }
      }
    }

    // ── per-binding rules ────────────────────────────────────────────────────
    /** Action IDS that at least one surface names. Keyed on id, not id+version,
     * deliberately: a version nobody binds is not necessarily drift — an older
     * contract version stays registered so its surfaces and fixtures remain
     * checkable while doors move to the newer one. A binding naming an id at a
     * version that does not exist IS drift, and is reported as its own,
     * more specific problem below. */
    const boundActionIds = new Set<string>();

    for (const binding of bindings) {
      if (!(SURFACE_KINDS as readonly string[]).includes(binding.kind)) {
        problems.push({
          code: "binding_unknown_surface_kind",
          surface: binding.id,
          message: `surface '${binding.id}' declares kind '${binding.kind}', which is not one of ${SURFACE_KINDS.join(", ")}`,
        });
        continue;
      }

      const anyVersion = actionOrder.some((k) => actions.get(k)!.id === binding.action);
      if (!anyVersion) {
        problems.push({
          code: "binding_unknown_action",
          surface: binding.id,
          action: `${binding.action}@${binding.actionVersion}`,
          message:
            `surface '${binding.id}' binds action '${binding.action}', which is not registered; ` +
            `every reachable surface resolves to a registered action`,
        });
        continue;
      }

      const action = actions.get(actionKey(binding.action, binding.actionVersion));
      if (!action) {
        problems.push({
          code: "binding_unknown_action_version",
          surface: binding.id,
          action: `${binding.action}@${binding.actionVersion}`,
          message:
            `surface '${binding.id}' binds action '${binding.action}' at version ${binding.actionVersion}, ` +
            `which is not registered; a surface binds an exact contract version`,
        });
        continue;
      }

      // Only a binding that RESOLVES counts as giving its action a door.
      //
      // Crediting the id before the version check would let a stale binding —
      // one left pointing at a version that no longer exists after a bump —
      // suppress `action_unbound` for an action that genuinely has no working
      // door. That is precisely the "action with no door" defect this registry
      // exists to catch, so the two problems must be able to fire together.
      boundActionIds.add(binding.action);

      // The acceptance fence, stated as a build rule. `governorOnly` covers
      // more than admission — anything Governor reserves to itself — so this
      // one check fences admission, revocation, mandate activation and signer
      // registration alike, without a list of verb names to keep current.
      if (action.authority.governorOnly && isAgentReachable(binding.kind)) {
        problems.push({
          code: "authority_agent_surface",
          surface: binding.id,
          action: actionKey(action.id, action.version),
          message:
            `surface '${binding.id}' is agent-reachable ('${binding.kind}') but binds Governor-only action ` +
            `'${actionKey(action.id, action.version)}'; an authority action has no agent-facing door`,
        });
      }
    }

    // ── the forward direction ────────────────────────────────────────────────
    for (const key of actionOrder) {
      const action = actions.get(key)!;
      if (!boundActionIds.has(action.id)) {
        problems.push({
          code: "action_unbound",
          action: key,
          message:
            `action '${key}' has no surface binding; a registered action with no door is drift — ` +
            `bind it, or retire it with deprecatedBy`,
        });
      }
    }

    sealed = problems;
    return problems;
  }

  /** Rebuilt whenever the binding list grows, so an unsealed registry (tests,
   * per-connection construction) still resolves correctly. */
  let bindingIndex: Map<string, SurfaceBinding> | null = null;
  let indexedAt = -1;
  function binding(surfaceId: string): SurfaceBinding | undefined {
    if (bindingIndex === null || indexedAt !== bindings.length) {
      bindingIndex = new Map(bindings.map((b) => [b.id, b]));
      indexedAt = bindings.length;
    }
    return bindingIndex.get(surfaceId);
  }

  return {
    register,
    bind,
    validate,
    actions: () => actionOrder.map((k) => actions.get(k)!),
    bindings: () => [...bindings],
    get: (id, version) => actions.get(actionKey(id, version)),
    binding,
  };
}
