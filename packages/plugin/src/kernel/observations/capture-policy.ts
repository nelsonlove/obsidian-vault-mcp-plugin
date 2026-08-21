// OBSERVATION CAPTURE POLICY — Gate 0, WP2 (D16).
//
// How durably Governor keeps what it returned. Three levels, and the whole
// design turns on the difference:
//
//   ephemeral   nothing retained; supports nothing
//   evidence    identities, source state, response digest, shape, omissions,
//               truncation, availability — but not the bytes
//   replayable  all of that plus the exact payload Governor returned
//
// The level is ACTION AND SESSION POLICY, not caller preference. A caller may
// ask for a stronger level; it can never ask for a weaker one, because the
// things that depend on an observation — a proposal, a verifier, an admission
// — are not the caller's to weaken.
//
// Selective durability is the point. Capturing everything would turn a
// connection handshake into a permanent transcript and make retention a
// privacy problem; capturing nothing would make "this change was based on what
// I read" an assertion nobody can check. D16 draws the line at substance.

import type { CaptureLevel } from "../operations/action.js";

export { CAPTURE_LEVELS } from "../operations/action.js";
export type { CaptureLevel } from "../operations/action.js";

/** Weakest to strongest. Index IS the strength — see `atLeast`. */
const STRENGTH: Record<CaptureLevel, number> = { ephemeral: 0, evidence: 1, replayable: 2 };

/** Is `level` at least as strong as `floor`? */
export function atLeast(level: CaptureLevel, floor: CaptureLevel): boolean {
  return STRENGTH[level] >= STRENGTH[floor];
}

/** The strongest of several requirements. Requirements accumulate; they never
 * cancel, which is why this is a max and not a last-one-wins. */
export function strongestOf(...levels: CaptureLevel[]): CaptureLevel {
  return levels.reduce((a, b) => (STRENGTH[b] > STRENGTH[a] ? b : a));
}

/** Only the fields the policy needs. Structurally typed so this module never
 * imports the full action registry. */
export interface CapturePolicyAction {
  id: string;
  observations: { defaultCapture: CaptureLevel; supportsProposal: boolean };
}

export interface CaptureDecisionInput {
  action: CapturePolicyAction;
  /** The governed session, or null for an ad hoc read. */
  session: { id: string; governed: boolean } | null;
  /**
   * Whether this read returns SUBSTANTIVE vault content — note bodies,
   * excerpts, query rows, properties — as opposed to identities, availability
   * or navigation state. The distinction is D16's whole hinge.
   */
  substantive: boolean;
  /** True when the result will support a verification or authority claim. */
  supportingAuthority?: boolean;
  /** What the caller asked for. Honoured only when stronger. */
  requested?: CaptureLevel;
}

export interface CaptureDecision {
  level: CaptureLevel;
  /** Why, in one sentence, so a receipt can explain itself rather than just
   * asserting a level. */
  reason: string;
  /** True when the caller asked for something weaker and was overruled. Recorded
   * rather than silently dropped: a caller that believed it had opted out of
   * retention should be able to see that it did not. */
  requestedIgnored: boolean;
}

export function decideCapture(input: CaptureDecisionInput): CaptureDecision {
  const { action, session, substantive, supportingAuthority = false, requested } = input;

  let floor: CaptureLevel;
  let reason: string;

  if (supportingAuthority) {
    // Strongest floor, and it does not care about the session. A verifier
    // compares content; a digest proves that something was read, never what it
    // said.
    floor = "replayable";
    reason = "supports a verification or authority claim, which requires the exact returned payload";
  } else if (action.observations.defaultCapture === "ephemeral") {
    // Plumbing stays plumbing. An action declared ephemeral returns nothing
    // substantive by contract, so a governed session does not promote it.
    floor = "ephemeral";
    reason = `action '${action.id}' is declared ephemeral: low-information plumbing that supports no governed work`;
  } else if (substantive && session?.governed) {
    floor = "replayable";
    reason = "substantive vault content read inside a governed session";
  } else if (substantive) {
    // `strongestOf`, not a hardcoded "evidence". The default table says a
    // substantive ad hoc read is evidence "unless policy enables replayable" —
    // and the action's own declared default IS that policy. Hardcoding the
    // floor silently downgraded an action explicitly marked `replayable`
    // (something verification-adjacent, say) the moment it was read outside a
    // governed session, with no signal that anything had been overruled.
    floor = strongestOf("evidence", action.observations.defaultCapture);
    reason =
      floor === "evidence"
        ? "substantive read outside a governed session: identities and state are retained, the payload is not"
        : `substantive read outside a governed session, raised to '${floor}' by the action's own declared default`;
  } else {
    floor = action.observations.defaultCapture;
    reason = `non-substantive read; the action's declared default (${action.observations.defaultCapture}) applies`;
  }

  const level = requested ? strongestOf(floor, requested) : floor;
  const requestedIgnored = requested !== undefined && !atLeast(requested, floor);
  return {
    level,
    reason: requestedIgnored ? `${reason}; the caller's weaker request for '${requested}' was ignored` : reason,
    requestedIgnored,
  };
}
