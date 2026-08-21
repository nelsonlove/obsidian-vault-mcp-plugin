// OBSERVATION DEPENDENCIES — Gate 0, WP2 (D16).
//
// The rule that gives capture levels their teeth: an ephemeral observation can
// never support a proposal, a verification result, or an admission. Governor
// re-observes durably instead of promoting a result it did not keep.
//
// Why this is the load-bearing half rather than bookkeeping: without it, "this
// change was based on what I read" degrades into an assertion nobody can check.
// The entire point of capturing reads is that a reviewer can see what the agent
// was actually shown — and a level that retains nothing cannot deliver that,
// however confidently a later claim cites it.
//
// The checks are deliberately conservative in the same direction throughout:
// unknown, partial, truncated, omitted and unavailable all REFUSE. A claim
// built on a vault that was never fully seen is not a weaker claim; it is a
// different one.
//
// The six revalidation checks the design requires, and where each lives:
//
//   same session or admitted source        `foreign_session`
//   the action permitted its use           `action_not_permitted`
//   capture sufficient for the predicate   `insufficient_capture`
//   sources still match, or staleness is
//     handled                              `stale_dependency` /
//                                          `staleness_unchecked`
//   scope and mandate covered it           `scope_mismatch` / `mandate_mismatch`
//   nothing unavailable, omitted or
//     truncated                            `unavailable_source` /
//                                          `omitted_dependency` /
//                                          `truncated_dependency`
//
// An earlier draft implemented three of the six, and its type could not carry
// the data the other three needed — `sourceState` was declared and never read,
// and scope and mandate were absent from the observation entirely. Half a
// revalidation reads exactly like a whole one to anyone who does not go
// looking, which is the worst property a check can have.

import { atLeast, type CaptureLevel } from "./capture-policy.js";

/** What is depending on the observation. Each has its own sufficiency floor. */
export type DependentClaim = "proposal" | "verification" | "admission";

/**
 * The minimum capture level each claim can be built on.
 *
 * `proposal` accepts `evidence`: a proposal states what it intends to change
 * and carries its own diff, so identities and source state can be enough to
 * establish what it was working from.
 *
 * `verification` and `admission` require `replayable`. A verifier compares
 * CONTENT — a digest proves that something was read, never what it said — and
 * an admission rests on the verification. Accepting evidence there would let a
 * predicate claim to have checked bytes nobody kept.
 */
const REQUIRED: Record<DependentClaim, CaptureLevel> = {
  proposal: "evidence",
  verification: "replayable",
  admission: "replayable",
};

/** Stable codes, with the reason each exists. Cited by build output and
 * receipts, so renaming one unlinks a documented failure from its emitter. */
export const DEPENDENCY_PROBLEMS: Record<string, string> = {
  action_not_permitted:
    "the action that produced this observation does not permit its use as support; an action declares whether its observations may back a governed claim, and that declaration is not the caller's to override",
  stale_dependency:
    "a source has changed since it was observed, so the claim rests on state that no longer exists; re-observe, or state explicitly how the plan handles the change",
  staleness_unchecked:
    "current source state was not supplied, so staleness could not be checked — refused for admission, which must never rest on evidence that might already be obsolete",
  scope_mismatch:
    "the observation was made under a different effective scope than the claim asserts, so it may cover material the claim's scope excludes",
  mandate_mismatch:
    "the observation was made under a different mandate than the claim asserts",
  omitted_dependency:
    "the observation excluded results, so it cannot support a claim that reasons over the whole of what it read",
  no_dependencies:
    "the claim requires supporting observations and names none; a claim with no evidence is not a weaker claim, it is an unsupported one",
  ephemeral_dependency:
    "an ephemeral observation retained nothing, so nothing depending on it can be re-checked; re-observe durably rather than promoting it",
  insufficient_capture:
    "the observation's capture level is below what this claim needs — most often evidence where a verifier needs the exact bytes it compared",
  foreign_session:
    "the observation belongs to another session; evidence does not transfer between work envelopes without an explicit admitted source",
  truncated_dependency:
    "the observation's result was truncated, so it cannot support a claim about the whole of what it read",
  unavailable_source:
    "a source the observation needed was unavailable, so it describes a vault that was never fully seen",
};

export interface DependencyObservation {
  id: string;
  level: CaptureLevel;
  sessionId: string | null;
  /**
   * The producing action, and whether it permits its observations to back a
   * governed claim. Carried on the observation rather than looked up, so this
   * module stays independent of the registry — and so the answer is the one
   * that applied AT CAPTURE, not whatever the registry says later.
   */
  action: { id: string; version: number; supportsProposal: boolean };
  /** The scope and mandate in force when the observation was made. */
  effectiveScopeDigest: string | null;
  mandateId: string | null;
  sourceState: Array<{ identity: string; path: string | null; revision: string | null; contentDigest: string | null }>;
  result: { truncated: boolean; unavailable: string[]; excludedCount?: number | null; payloadObject?: string | null };
}

export interface DependencyProblem {
  code: keyof typeof DEPENDENCY_PROBLEMS;
  observationId: string | null;
  message: string;
}

export interface DependencyCheck {
  observations: DependencyObservation[];
  claim: DependentClaim;
  /** The session the dependent claim belongs to. */
  sessionId: string | null;
  /** Observation ids from another session that a human has explicitly admitted
   * as a source. Empty by default — cross-session evidence is a decision, never
   * a convenience. */
  admittedForeign?: string[];
  /** The scope and mandate the CLAIM asserts, compared against the ones each
   * observation was made under. */
  effectiveScopeDigest?: string | null;
  mandateId?: string | null;
  /**
   * Current content digest per source identity, for the staleness check.
   *
   * Optional for a proposal — a proposal carries its own diff and may
   * legitimately describe a change to state it has already re-read. REQUIRED
   * for an admission: standing must never rest on evidence that might already
   * be obsolete, and "we could not check" is not a reason to proceed. Absent
   * for an admission produces `staleness_unchecked` rather than silence.
   */
  currentSources?: Record<string, string | null>;
}

export function validateDependencies(check: DependencyCheck): DependencyProblem[] {
  const problems: DependencyProblem[] = [];
  const required = REQUIRED[check.claim];
  const admitted = new Set(check.admittedForeign ?? []);

  const push = (code: keyof typeof DEPENDENCY_PROBLEMS, observationId: string | null, detail = "") =>
    problems.push({ code, observationId, message: `${DEPENDENCY_PROBLEMS[code]}${detail ? ` (${detail})` : ""}` });

  if (check.observations.length === 0) {
    push("no_dependencies", null, `claim: ${check.claim}`);
    return problems;
  }

  for (const obs of check.observations) {
    // Checked first and separately from `insufficient_capture`, because
    // "retained nothing" and "retained the wrong thing" are different failures
    // and a caller fixes them differently.
    if (obs.level === "ephemeral") {
      push("ephemeral_dependency", obs.id);
      continue;
    }
    // An action declares whether its observations may back a governed claim.
    // That declaration belongs to the action, not to whatever later wants to
    // cite it.
    if (!obs.action.supportsProposal) {
      push("action_not_permitted", obs.id, `action '${obs.action.id}@${obs.action.version}'`);
    }
    if (!atLeast(obs.level, required)) {
      push("insufficient_capture", obs.id, `has '${obs.level}', ${check.claim} needs '${required}'`);
    }
    if (obs.sessionId !== check.sessionId && !admitted.has(obs.id)) {
      push("foreign_session", obs.id, `observed in '${obs.sessionId}', claimed in '${check.sessionId}'`);
    }
    // Truncation only invalidates a claim about the WHOLE result. A proposal
    // over one named note is not weakened by a listing having been capped, so
    // this is scoped to the claims that reason over completeness.
    if (obs.result.truncated && required === "replayable") {
      push("truncated_dependency", obs.id);
    }
    if (obs.result.unavailable.length > 0) {
      push("unavailable_source", obs.id, obs.result.unavailable.join(", "));
    }
    // Omission is its own failure, distinct from truncation: a truncated result
    // was cut short, an omitted one had entries removed. Both mean the claim
    // does not describe the whole of what was read.
    if ((obs.result.excludedCount ?? 0) > 0 && required === "replayable") {
      push("omitted_dependency", obs.id, `${obs.result.excludedCount} excluded`);
    }
    if (check.effectiveScopeDigest !== undefined && obs.effectiveScopeDigest !== check.effectiveScopeDigest) {
      push("scope_mismatch", obs.id, `observed under '${obs.effectiveScopeDigest}', claimed under '${check.effectiveScopeDigest}'`);
    }
    if (check.mandateId !== undefined && obs.mandateId !== check.mandateId) {
      push("mandate_mismatch", obs.id, `observed under '${obs.mandateId}', claimed under '${check.mandateId}'`);
    }

    // Staleness. Fail-closed for admission, permissive for a proposal — see
    // `currentSources`.
    if (check.currentSources === undefined) {
      if (check.claim === "admission") push("staleness_unchecked", obs.id);
    } else {
      for (const src of obs.sourceState) {
        if (!(src.identity in check.currentSources)) {
          if (check.claim === "admission") push("staleness_unchecked", obs.id, `no current state for '${src.identity}'`);
          continue;
        }
        if (check.currentSources[src.identity] !== src.contentDigest) {
          push("stale_dependency", obs.id, `'${src.identity}' changed since it was observed`);
        }
      }
    }
  }

  return problems;
}
