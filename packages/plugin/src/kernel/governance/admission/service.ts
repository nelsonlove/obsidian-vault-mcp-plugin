// ADMISSION SERVICE — the only code allowed to advance standing (WP6, §9).
//
// The isolation is CAPABILITY-SHAPED, not name-shaped: the constructor takes
// a `standingAdvance` closure — compare-and-swap over the standing ref —
// that the wiring builds from the history repository and hands to this
// service alone. The guide is explicit that "a public TypeScript method with
// a suggestive name is not sufficient isolation": nothing here is placed on
// a plugin instance, a view, a command registry, an MCP registry, or a DOM
// property, and the source-scan test enforces that the standing ref's name
// is constructed nowhere outside the refs module, this package, and the one
// wiring point that builds the capability.
//
// The required ordering (§10), each step durable before the next:
//
//   1. revalidate subject and authority   (policy.requireAdmissible, fresh)
//   2. construct and durably store claim  (unattached evidence if we crash)
//   3. compare-and-swap the standing ref  (the actual authority transition)
//   4. append the settlement record       (what happened, for recovery)
//   5. refresh rebuildable projections    (a callback; failures degrade)
//
// A crash between 2 and 3 leaves a retriable claim; between 3 and 4 leaves a
// consistent-but-unrecorded settlement the recovery pass completes. Nothing
// in any window leaves a ref pointing at evidence that does not exist,
// because the claim lands BEFORE the ref moves.

import { AdmissionRefusedError, requireAdmissible, requireCohortAdmissible, type AdmissionRequest, type CohortAdmissionRequest } from "./policy.js";
import { buildAdmissionClaim, type AdmissionClaimV1, type ClaimStore } from "./settlement.js";
import { RefCasError } from "../history-store/types.js";
import { subjectDigest, type CohortSubjectV1, type ProposalItemSubjectV1 } from "../contracts/subject-v1.js";
import type { VerificationOutcome } from "../verification/verify.js";
import type { CohortCoverageOutcome } from "../cohorts/coverage.js";
import type { ProposalV1 } from "../proposals/proposal.js";

/**
 * The capability: CAS over the standing ref, pre-bound to the ref name by
 * whoever built it. Receiving (expected, next) and NOT a ref name is the
 * point — the service cannot address arbitrary refs even if it wanted to.
 */
export type StandingAdvance = (expectedClaimId: string | null, nextClaimId: string) => Promise<void>;

export interface AdmissionDeps {
  claims: ClaimStore;
  standingAdvance: StandingAdvance;
  /**
   * Run the subject's required predicates, NOW, and return the outcome. §9:
   * the service "resolves every required predicate" — itself, at admission
   * time. This is a capability like standingAdvance: the wiring builds it
   * from the predicate registry and evidence sources, and the REQUEST has no
   * field a caller-supplied verdict could arrive through. The first draft
   * checked caller-provided records instead, and the review admitted an
   * unverified subject with hand-forged passed:true records; this closure is
   * that hole closed structurally.
   */
  verify: (subject: ProposalItemSubjectV1) => Promise<VerificationOutcome>;
  /**
   * Run full coverage over a frozen cohort, NOW — the cohort-shaped verify
   * capability (WP7b). Same rule as `verify`: the service resolves
   * verification itself; the request has no field a verdict could ride in.
   * Optional: a wiring that admits only items never provides it, and
   * admitCohort refuses without it rather than guessing.
   */
  verifyCohort?: (frozenSubject: CohortSubjectV1, cohortDigest: string, memberProposals: readonly ProposalV1[]) => Promise<CohortCoverageOutcome>;
  /** Current standing claim id, read fresh — the CAS expectation. */
  currentStanding: () => Promise<string | null>;
  /** Step 4: append the settlement record. Failures here are retried by recovery, not silently dropped. */
  recordSettlement: (record: { claimId: string; subjectDigest: string; at: number }) => Promise<void>;
  /** Step 5: rebuildable projections. A throw degrades observability only. */
  refreshProjections?: () => Promise<void>;
  now: () => number;
  rand?: () => Uint8Array | undefined;
}

export interface AdmissionResult {
  claim: AdmissionClaimV1;
}

export interface AdmissionService {
  /**
   * Admit one proposal. Throws AdmissionRefusedError (typed, specific) when
   * the refusal table says no; throws RefCasError when standing moved under
   * the admission (the caller re-reads and re-decides — never retries
   * blindly, because the new standing may change the human's answer).
   */
  admit(request: AdmissionRequest): Promise<AdmissionResult>;
  /**
   * Admit a frozen cohort under ONE gesture: one claim whose subjectDigest
   * is the cohort digest and whose coveredNotes are DERIVED from the frozen
   * manifest (pinned — no caller field), one CAS. Same ordering, same
   * refusal discipline, same serialization as admit.
   */
  admitCohort(request: CohortAdmissionRequest): Promise<AdmissionResult>;
}

export function createAdmissionService(deps: AdmissionDeps): AdmissionService {
  // Admissions serialize: two concurrent gestures racing the same standing
  // ref would both read the same expectation, and the loser's refusal should
  // be the clean RefCasError from a consistent read — not an interleaved
  // claim store.
  let chain: Promise<unknown> = Promise.resolve();
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  // ONE GESTURE, ONE CLAIM — enforced at runtime, not only by the pane's
  // structure (governor-lead's WP8 proposal): a gesture ref is a one-shot
  // token, so a claim carrying a ref that any existing claim already carries
  // refuses. This kills every spelling of the successor-reuse violation at
  // once — recursion, a second direct call, an item-path loop, helper
  // indirection, and the ones nobody has imagined — and it survives Gate 2,
  // where mandates admit without a pane to read. Checked INSIDE the
  // serialized chain beside the duplicate check; empty refs never reach it
  // (authority_missing refuses them first).
  async function requireGestureUnused(gestureRef: string): Promise<void> {
    if (!gestureRef) return;
    const prior = (await deps.claims.all()).find((c) => c.authority.gestureRef === gestureRef);
    if (prior) {
      throw new AdmissionRefusedError(
        "gesture_replayed",
        `gesture ${gestureRef} already authorised claim ${prior.id}; one gesture covers exactly one claim — a further decision needs its own gesture`
      );
    }
  }

  function deriveCohortCoveredNotes(frozenSubject: CohortSubjectV1): Array<{ vaultId: string; noteId: string; subjectDigest: string }> {
    // DERIVED from the manifest, in the same breath as the digest — the #334
    // shaping rule at cohort scale. subjectDigest(item) here is the same
    // computation the per-item resolver compares against.
    return frozenSubject.items.map((item) => ({ vaultId: item.vaultId, noteId: item.noteId, subjectDigest: subjectDigest(item).value }));
  }

  return {
    admitCohort(request) {
      return serialized(async () => {
        const now = deps.now();
        if (!deps.verifyCohort) {
          throw new AdmissionRefusedError("verification_unavailable", "no cohort verification capability is wired; a check that cannot run has not passed");
        }
        const cohortDigest = subjectDigest(request.frozenSubject);
        // The member proposals ride the REQUEST into the capability, so the
        // evidence correlation is per-call by construction — a shared map
        // populated outside this serialized chain raced across concurrent
        // admissions (review finding: caller A's cleanup emptied it before
        // caller B's coverage ran, refusing healthy members).
        const coverage = await deps.verifyCohort(request.frozenSubject, cohortDigest.value, request.memberProposals);
        requireCohortAdmissible(request, coverage, now);
        if (request.authority.kind === "human-gesture") await requireGestureUnused(request.authority.gestureRef);

        // Duplicate check inside the serialized chain, cohort-shaped: if what
        // stands already covers this exact cohort digest, refuse truthfully.
        const expected = await deps.currentStanding();
        if (expected !== null) {
          const standingClaim = await deps.claims.byId(expected);
          if (standingClaim && standingClaim.subjectDigest.value === cohortDigest.value) {
            throw new AdmissionRefusedError("already_admitted", `this exact cohort already stands as claim ${standingClaim.id}`);
          }
        }

        const claim = buildAdmissionClaim({
          subjectDigest: cohortDigest,
          proposalId: request.memberProposals.map((p) => p.id).join(","),
          gestureRef: request.authority.kind === "human-gesture" ? request.authority.gestureRef : "",
          verification: coverage.items.flatMap((i) => i.records),
          expectedStanding: expected,
          coveredNotes: deriveCohortCoveredNotes(request.frozenSubject),
          now,
          rand: deps.rand?.(),
        });
        await deps.claims.append(claim);
        await deps.standingAdvance(expected, claim.id);
        await deps.recordSettlement({ claimId: claim.id, subjectDigest: claim.subjectDigest.value, at: now });
        try {
          await deps.refreshProjections?.();
        } catch (e) {
          console.error("[governor] projection refresh after cohort admission failed (rebuildable)", e);
        }
        return { claim };
      });
    },

    admit(request) {
      return serialized(async () => {
        const now = deps.now();

        // 1. Revalidate, FRESH — the facts may have aged while this call
        //    waited behind another admission — and RUN the verification
        //    ourselves. The caller's opinion of the verdict never existed as
        //    an input.
        const outcome = await deps.verify(request.subject);
        requireAdmissible(request, outcome.records, now);
        if (request.authority.kind === "human-gesture") await requireGestureUnused(request.authority.gestureRef);
        if (!outcome.passed) {
          // requireAdmissible refuses per-record failures with specifics;
          // this is the belt for an outcome failing for any other reason
          // (zero records for a subject requiring some, an aggregate rule).
          throw new AdmissionRefusedError("verification_failed", "verification did not pass for the exact subject");
        }

        // 2. Durable claim, before any authority moves. If we crash after
        //    this line, the claim is unattached evidence: retriable, harmless.
        const expected = await deps.currentStanding();
        // Duplicate-admission check INSIDE the serialized chain (the wiring's
        // own pre-check runs outside it, so two genuinely concurrent trusted
        // clicks could both pass it): if what currently stands already covers
        // this exact subject, a second admission would chain a duplicate
        // commit recording nothing new. Refused, truthfully.
        if (expected !== null) {
          const standingClaim = await deps.claims.byId(expected);
          if (standingClaim && standingClaim.subjectDigest.value === request.proposal.subjectDigest.value) {
            throw new AdmissionRefusedError(
              "already_admitted",
              `this exact subject already stands as claim ${standingClaim.id}; a second admission would record nothing new`
            );
          }
        }
        const claim = buildAdmissionClaim({
          subjectDigest: request.proposal.subjectDigest,
          proposalId: request.proposal.id,
          gestureRef: request.authority.kind === "human-gesture" ? request.authority.gestureRef : "",
          verification: outcome.records,
          expectedStanding: expected,
          // DERIVED from the subject, in the same breath as the digest — no
          // caller field exists for it (#334's shaping rule).
          coveredNotes: [
            { vaultId: request.subject.vaultId, noteId: request.subject.noteId, subjectDigest: request.proposal.subjectDigest.value },
          ],
          now,
          rand: deps.rand?.(),
        });
        await deps.claims.append(claim);

        // 3. The authority transition itself. RefCasError propagates — the
        //    caller re-reads and re-decides.
        await deps.standingAdvance(expected, claim.id);

        // 4. Settlement record. A failure here is NOT unwound (the admission
        //    HAS happened); recovery completes the record from the claim.
        await deps.recordSettlement({ claimId: claim.id, subjectDigest: claim.subjectDigest.value, at: now });

        // 5. Projections: best-effort, rebuildable by definition — D05's own
        //    words: "Mutable indexes are rebuildable projections, never
        //    authority." A projection failure cannot be an integrity problem
        //    because a projection is never authority; the event-driven nudge
        //    machinery rebuilds it from the stores.
        try {
          await deps.refreshProjections?.();
        } catch (e) {
          console.error("[governor] projection refresh after admission failed (rebuildable)", e);
        }

        return { claim };
      });
    },
  };
}

export { AdmissionRefusedError, RefCasError };
