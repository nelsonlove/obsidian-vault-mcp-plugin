// ADMISSION WIRING — where the capabilities are built and nowhere else (WP6b-2).
//
// This file is THE deliberate addition to the standing-isolation scan's
// allowlist: it is the one production module that may name the standing ref,
// because it is the one that builds the `standingAdvance` capability and
// hands it — as a constructor argument, never a property — to the
// AdmissionService. Everything here is closure-held; nothing lands on the
// plugin instance, a view, a registry, or the DOM (§9, and the same pattern
// gesture.ts already relies on).
//
// FAIL DIRECTION, declared where a reader looks for it (threat model:
// "Every new control must declare its row before release"):
//
//   Mandate, attestation, and admission validation — FAIL CLOSED; the
//   subject REMAINS PROPOSED. Every refusal, every unknown, every crash
//   window before the CAS leaves the note not-admitted. The single
//   deliberate exception is documented at recordSettlement: a crash AFTER
//   the CAS leaves the admission standing with a degraded receipt, because
//   un-ringing the CAS would rewrite authority (#306's write-then-log call).
//
// The standing ref points at ADMISSION COMMITS, not claim ids: a git ref
// must name an object, so each admission writes a commit whose blob is the
// claim JSON and whose message names the claim id, chained on the previous
// standing commit. The kernel service works in claim ids; the capabilities
// built here translate. CAS runs over commit oids, so the git-level
// exactly-one-winner property carries the claim-level one.

import { createAdmissionService, type AdmissionService } from "../kernel/governance/admission/service.js";
import { standingHealth, type StandingHealthReport } from "../kernel/governance/admission/standing-health.js";
import { freezeCohort, excludeAndRefreeze, type FrozenCohort, type FreezeInput } from "../kernel/governance/cohorts/freeze.js";
import { verifyCohortCoverage } from "../kernel/governance/cohorts/coverage.js";
import { selectProposals, type CohortSelector } from "../kernel/governance/cohorts/cohort.js";
import { createClaimStore, type ClaimIo } from "../kernel/governance/admission/settlement.js";
import { AdmissionRefusedError } from "../kernel/governance/admission/policy.js";
import { buildProposalItemSubject, subjectDigest } from "../kernel/governance/contracts/subject-v1.js";
import { digestBytes } from "../kernel/governance/contracts/digest.js";
import { standingRef } from "../kernel/governance/history-store/refs.js";
import { RefCasError, type ObjectId } from "../kernel/governance/history-store/types.js";
import type { HistoryRepository } from "../kernel/governance/history-store/repository.js";
import { createDefaultPredicateRegistry } from "../kernel/governance/verification/predicates.js";
import { verifySubject } from "../kernel/governance/verification/verify.js";
import type { ProposalStore } from "../kernel/governance/proposals/proposal-store.js";
import type { ProposalV1 } from "../kernel/governance/proposals/proposal.js";

export interface AdmissionUiDeps {
  /** Pending new-style proposals, for the pane's list. */
  pending(): Promise<ProposalV1[]>;
  /**
   * Freeze a selection of pending proposals into an immutable decision
   * subject (WP7b). Pure selection + freeze — confers nothing; the refusal
   * reason (mixed classes, open revisions…) comes back verbatim for the UI.
   */
  freezeSelection(selector: CohortSelector, recoveryUnit: "item" | "cohort"): Promise<{ ok: true; frozen: FrozenCohort; members: ProposalV1[] } | { ok: false; reason: string }>;
  /**
   * Admit a frozen cohort under one gesture. Same reachability contract as
   * admitWithGesture; the gestureRef arrives from the gate.
   */
  admitCohortWithGesture(frozen: FrozenCohort, members: ProposalV1[], gestureRef: string): Promise<CohortAdmitOutcome>;
  /** #337 option 4 — claims-exist-chain-absent surfaced as critical. */
  standingHealth(): Promise<StandingHealthReport>;
  /** Split by finding: exclude members and produce the successor decision. */
  refreezeWithout(frozen: FrozenCohort, members: ProposalV1[], excludeProposalIds: string[], recoveryUnit: "item" | "cohort"): Promise<{ ok: true; frozen: FrozenCohort; members: ProposalV1[] } | { ok: false; reason: string }>;
  /**
   * Admit one proposal. `gestureRef` is minted by the CLICK HANDLER — this
   * function is reachable only through the pane's gesture chain, and the
   * unreachability (closure-held deps, addEventListener wiring, isRealGesture)
   * is the enforcement, exactly as it is for acceptNote.
   */
  admitWithGesture(proposalId: string, gestureRef: string): Promise<AdmitOutcome>;
  /**
   * Revert the note to the proposal's recorded base — D06: revert is a NEW
   * change producing NEW history, never a rewrite. The proposal is superseded;
   * the written-back bytes surface through the ordinary review machinery.
   */
  revertToBase(proposalId: string, gestureRef: string): Promise<RevertOutcome>;
}

export type CohortAdmitOutcome =
  | {
      ok: true;
      claimId: string;
      degraded: boolean;
      receipt: { subjectDigest: string; memberCount: number; predicates: string[]; verifier: string; coverage: "exact-and-total" };
    }
  | { ok: false; code: string; detail: string; failedNoteIds?: string[] };

export type AdmitOutcome =
  | {
      ok: true;
      claimId: string;
      /** True when the settlement record failed AFTER the CAS: the admission stands; the record is catching up (journal.status "degraded"). */
      degraded: boolean;
      /** Receipt material — the never-say rules need subject, predicate, verifier, and coverage NAMED. */
      receipt: { subjectDigest: string; predicates: string[]; verifier: string; coverage: "exact-and-total" };
    }
  | { ok: false; code: string; detail: string };

export type RevertOutcome = { ok: true; supersededProposalId: string } | { ok: false; code: string; detail: string };

export interface BuildAdmissionDeps {
  repo: () => Promise<HistoryRepository>;
  claimIo: ClaimIo;
  proposals: ProposalStore;
  /** Current note bytes, or null when the note does not exist. */
  readNoteBytes(path: string): Promise<Uint8Array | null>;
  /** Write note bytes through the plugin's ordinary write machinery (revert). */
  writeNoteBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Append one settlement line to the acceptance log. */
  appendSettlement(record: { event: "admission-settlement"; claimId: string; subjectDigest: string; ts: string }): Promise<void>;
  /** Rebuildable projections refresh (the pane nudge). Optional. */
  refreshProjections?: () => Promise<void>;
  now?: () => number;
}

/** The admission-commit message format — the claimId↔oid translation's carrier. */
const STANDING_MESSAGE = /^admission ([0-9a-f-]+)\n/;

export function buildAdmission(deps: BuildAdmissionDeps): AdmissionUiDeps {
  const now = deps.now ?? (() => Date.now());
  const claims = createClaimStore(deps.claimIo);
  const registry = createDefaultPredicateRegistry();

  /** The claim id the standing ref currently names, or null. */
  async function currentStanding(): Promise<string | null> {
    const repo = await deps.repo();
    const oid = await repo.resolveRef(standingRef());
    if (oid === null) return null;
    const commit = await repo.readCommit(oid);
    const m = STANDING_MESSAGE.exec(commit.message + "\n");
    if (!m) {
      // A standing ref naming a commit that is not an admission commit is
      // §10's critical health failure — surfaced, never read as absence.
      throw new Error(`standing ref names commit ${oid} whose message is not an admission record — critical health failure`);
    }
    return m[1];
  }

  /** CAS in claim ids, executed over commit oids. */
  async function standingAdvance(expectedClaimId: string | null, nextClaimId: string): Promise<void> {
    const repo = await deps.repo();
    const curOid = await repo.resolveRef(standingRef());
    const curClaim = curOid === null ? null : await claimIdOf(repo, curOid);
    if (curClaim !== expectedClaimId) throw new RefCasError(standingRef(), expectedClaimId, curClaim);
    const claim = await claims.byId(nextClaimId);
    // The commit's blob carries the claim JSON — the standing chain is
    // readable by stock git without the jsonl store (D08's export posture).
    const blob = await repo.writeBlob(new TextEncoder().encode(JSON.stringify(claim ?? { id: nextClaimId })));
    const tree = await repo.writeTree([{ mode: "100644", path: "claim.json", oid: blob, type: "blob" }]);
    const commit = await repo.writeCommit({
      message: `admission ${nextClaimId}\n`,
      tree,
      parents: curOid === null ? [] : [curOid],
      timestamp: Math.floor(now() / 1000),
    });
    await repo.casRef(standingRef(), curOid, commit);
  }

  async function claimIdOf(repo: HistoryRepository, oid: ObjectId): Promise<string | null> {
    const commit = await repo.readCommit(oid);
    const m = STANDING_MESSAGE.exec(commit.message + "\n");
    return m ? m[1] : null;
  }

  /** Base bytes from the proposal's recording ref chain (the base commit is the chain's root). */
  async function baseBytesOf(proposal: ProposalV1): Promise<Uint8Array | null> {
    if (proposal.recordingRef === null || proposal.subject.path === null) return null;
    const repo = await deps.repo();
    const chain = await repo.log(proposal.recordingRef, 10);
    const baseCommit = chain[chain.length - 1]; // oldest = the base snapshot
    if (!baseCommit) return null;
    return readFileFromTree(repo, baseCommit.tree, proposal.subject.path);
  }

  const service: AdmissionService = createAdmissionService({
    claims,
    standingAdvance,
    currentStanding,
    verifyCohort: async (frozenSubject, cohortDigest, memberProposals) => {
      // The cohort-shaped verify capability: full coverage, evidence per item
      // resolved by Governor from the recording refs and the current vault —
      // the same sources the item path uses, exact and total. The member
      // proposals arrive ON THE CALL, so the item↔proposal correlation is a
      // local map per invocation — no state shared across admissions (the
      // shared-map draft raced: one call's cleanup emptied another's
      // correlation before its serialized coverage ran, refusing healthy
      // members and feeding split-by-finding corrupted evidence).
      const byIdentity = new Map(memberProposals.map((p) => [`${p.subject.vaultId}\u0000${p.subject.noteId}`, p]));
      const shaped = {
        subject: frozenSubject,
        digest: { algorithm: "sha256" as const, value: cohortDigest },
        memberProposalIds: frozenSubject.items.map((item) => byIdentity.get(`${item.vaultId}\u0000${item.noteId}`)?.id ?? ""),
      };
      return verifyCohortCoverage(
        registry,
        shaped as import("../kernel/governance/cohorts/freeze.js").FrozenCohort,
        async (item) => {
          const proposedBytes = item.path === null ? null : await deps.readNoteBytes(item.path);
          const proposal = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`) ?? null;
          const baseBytes = proposal ? await baseBytesOf(proposal) : null;
          return { baseBytes, proposedBytes };
        },
        now()
      );
    },
    verify: async (subject) => {
      // Evidence resolved by GOVERNOR at admission time: proposed bytes are
      // the CURRENT note (what the human is looking at), base bytes replay
      // from the recording. The caller supplies neither.
      const proposal = subjectProposal.get(subject);
      const proposedBytes = subject.path === null ? null : await deps.readNoteBytes(subject.path);
      const baseBytes = proposal ? await baseBytesOf(proposal) : null;
      return verifySubject(registry, subject, { baseBytes, proposedBytes }, now());
    },
    recordSettlement: async (r) => {
      await deps.appendSettlement({
        event: "admission-settlement",
        claimId: r.claimId,
        subjectDigest: r.subjectDigest,
        ts: new Date(r.at).toISOString(),
      });
    },
    refreshProjections: deps.refreshProjections,
    now,
  });

  // The verify closure needs the PROPOSAL for the recording ref, but the
  // service hands it only the subject. Correlated through a WeakMap keyed on
  // the exact subject object admitWithGesture passes — no ambient state, no
  // id-keyed map that could cross admissions.
  const subjectProposal = new WeakMap<object, ProposalV1>();

  function cohortReceipt(subjectDigest: string, frozen: FrozenCohort) {
    return {
      subjectDigest,
      memberCount: frozen.subject.items.length,
      predicates: [...new Set(frozen.subject.items.flatMap((i) => i.predicates.map((p) => `${p.id}@${p.version}`)))],
      verifier: "governor cohort coverage (deterministic, run at admission, exact and total)",
      coverage: "exact-and-total" as const,
    };
  }

  return {
    async pending() {
      return deps.proposals.pending();
    },

    async freezeSelection(selector, recoveryUnit) {
      try {
        const pending = await deps.proposals.pending();
        const selected = selectProposals(pending, selector);
        if (selected.length === 0) return { ok: false, reason: "the selection matches no pending proposals" };
        const frozen = freezeCohort({ items: selected, resolvedScope: { include: [], exclude: [] }, recoveryUnit });
        // Members are returned in the SUBJECT's canonical item order (the
        // freeze sorts items by noteId; selection order is arbitrary), so
        // members[i] corresponds to frozen.subject.items[i] for every caller.
        const byId = new Map<string, ProposalV1>(selected.map((m) => [m.id, m]));
        return { ok: true, frozen, members: frozen.memberProposalIds.map((id) => byId.get(id)!) };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async refreezeWithout(frozen, members, excludeProposalIds, recoveryUnit) {
      try {
        const input: FreezeInput = {
          items: members,
          resolvedScope: frozen.subject.resolvedScope,
          recoveryUnit,
          excludedProposalIds: [...frozen.subject.excludedProposalIds],
        };
        const successor = excludeAndRefreeze(input, frozen, excludeProposalIds);
        const byId = new Map<string, ProposalV1>(members.map((m) => [m.id, m]));
        return { ok: true, frozen: successor, members: successor.memberProposalIds.map((id) => byId.get(id)!) };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },

    async standingHealth(): Promise<StandingHealthReport> {
      // #337 option 4: the chain-absent direction surfaced as CRITICAL. The
      // chain reader reuses claimIdOf — one canonical parse of the standing
      // commit message, never a second regex.
      return standingHealth({
        claims,
        standingChain: async () => {
          const repo = await deps.repo();
          const head = await repo.resolveRef(standingRef());
          if (head === null) return [];
          const ids: string[] = [];
          for (const entry of await repo.log(standingRef(), 100000)) {
            const id = await claimIdOf(repo, entry.oid);
            if (id !== null) ids.push(id);
          }
          return ids;
        },
      });
    },

    async admitCohortWithGesture(frozen, members, gestureRef) {
      // The degraded discriminator is standing MOVEMENT during this call —
      // the item path's rule, applied at cohort scale. A failed pre-read is
      // "unknown", which suppresses the degraded-success branch entirely.
      let preHead: string | null = null;
      let preHeadKnown = false;
      try {
        // RE-FETCH EVERY MEMBER at click time: the caller's array is a
        // freeze-time snapshot, and an authority/development flip that
        // changes no note bytes (a revision request, a concurrent admission)
        // is invisible to byte drift — only fresh facts can see it. The
        // policy's member table then judges the CURRENT proposals.
        const fresh: ProposalV1[] = [];
        for (const m of members) {
          const cur = await deps.proposals.get(m.id);
          if (!cur) return { ok: false, code: "proposal_unknown", detail: `member proposal ${m.id} no longer exists` };
          fresh.push(cur);
        }
        const byIdentity = new Map(fresh.map((m) => [`${m.subject.vaultId}\u0000${m.subject.noteId}`, m]));

        // Already standing? Refuse TRUTHFULLY and retry the projection
        // catch-up so the pane self-heals (the item path's F2 rule).
        try {
          preHead = await currentStanding();
          preHeadKnown = true;
        } catch {
          preHead = null;
        }
        if (preHead !== null) {
          const headClaim = await claims.byId(preHead);
          // Compared against the RECOMPUTED cohort digest, never the caller's
          // precomputed frozen.digest (freeze.ts's own obligation): a
          // mis-correlated frozen/members pair must not stamp never-admitted
          // members "admitted" under a claim that does not cover them.
          if (headClaim && headClaim.subjectDigest.value === subjectDigest(frozen.subject).value) {
            for (const m of fresh) {
              try {
                await deps.proposals.setVerification(m.id, "passed", now());
                await deps.proposals.markAdmitted(m.id, headClaim.id, now());
              } catch {
                /* projection remains behind; the refusal still tells the truth */
              }
            }
            return { ok: false, code: "already_admitted", detail: `this exact cohort already stands as claim ${headClaim.id}; nothing further to admit` };
          }
        }

        // RE-OBSERVE EVERY MEMBER: correlated to the frozen manifest by NOTE
        // IDENTITY (the manifest is canonically sorted; caller order is not
        // trusted) — any drifted member, any identity gap, aborts WHOLE with
        // the item(s) named.
        const drifted: string[] = [];
        for (const item of frozen.subject.items) {
          const proposal = byIdentity.get(`${item.vaultId}\u0000${item.noteId}`);
          if (!proposal) {
            return { ok: false, code: "subject_drift", detail: `frozen item ${item.noteId} has no corresponding member proposal` };
          }
          if (item.path === null) return { ok: false, code: "path_missing", detail: `member ${item.noteId} has no path to re-observe` };
          const current = await deps.readNoteBytes(item.path);
          if (current === null || digestBytes(current).value !== item.proposed.value) {
            drifted.push(item.noteId);
          }
        }
        if (drifted.length > 0) {
          return {
            ok: false,
            code: "subject_drift",
            detail: `${drifted.length} member(s) changed since the decision was frozen: ${drifted.join(", ")} — the whole cohort aborts; split by finding or re-freeze`,
            failedNoteIds: drifted,
          };
        }

        const { claim } = await service.admitCohort({
          frozenSubject: frozen.subject,
          gestureCoveredDigest: frozen.digest.value,
          memberProposals: fresh,
          authority: { kind: "human-gesture", gestureRef },
        });

        // Projections: every member catches up; failures degrade (D05).
        for (const m of fresh) {
          try {
            await deps.proposals.setVerification(m.id, "passed", now());
            await deps.proposals.markAdmitted(m.id, claim.id, now());
          } catch (e) {
            console.error("[governor] member projection update after cohort admission failed (rebuildable)", e);
          }
        }

        return {
          ok: true,
          claimId: claim.id,
          degraded: false,
          receipt: cohortReceipt(claim.subjectDigest.value, frozen),
        };
      } catch (e) {
        if (e instanceof AdmissionRefusedError) {
          return { ok: false, code: e.code, detail: e.message, ...(e.failedNoteIds && e.failedNoteIds.length > 0 ? { failedNoteIds: [...e.failedNoteIds] } : {}) };
        }
        if (e instanceof RefCasError) return { ok: false, code: e.code, detail: "standing moved during this admission; re-open and decide again" };
        // A throw AFTER the CAS is the degraded window: the admission may
        // stand while the settlement record is missing. Same movement
        // discrimination as the item path: standing must have advanced
        // DURING THIS CALL to a claim covering THIS cohort digest — then the
        // truth is a degraded success, the projections still catch up, and
        // the receipt says the settlement record was not written.
        try {
          const head = await currentStanding();
          if (preHeadKnown && head !== null && head !== preHead) {
            const claim = await claims.byId(head);
            if (claim && claim.subjectDigest.value === frozen.digest.value) {
              for (const m of members) {
                try {
                  await deps.proposals.setVerification(m.id, "passed", now());
                  await deps.proposals.markAdmitted(m.id, claim.id, now());
                } catch {
                  /* rebuildable */
                }
              }
              return { ok: true, claimId: head, degraded: true, receipt: cohortReceipt(claim.subjectDigest.value, frozen) };
            }
          }
        } catch {
          /* fall through to the plain failure */
        }
        return { ok: false, code: "admission_error", detail: e instanceof Error ? e.message : String(e) };
      }
    },

    async admitWithGesture(proposalId, gestureRef) {
      // Visible to the catch below: the degraded discriminator is standing
      // MOVEMENT during this call, so the pre-call head must survive the try.
      // `preHeadKnown` is the re-review's transient-fault sentinel: a FAILED
      // pre-read is "unknown", not "absent" — and an unknown starting point
      // suppresses the degraded-success branch entirely, because movement
      // cannot be asserted from a point nobody saw.
      let preHead: string | null = null;
      let preHeadKnown = false;
      try {
        const proposal = await deps.proposals.get(proposalId);
        if (!proposal) return { ok: false, code: "proposal_unknown", detail: `no proposal ${proposalId}` };
        if (proposal.subject.path === null) return { ok: false, code: "path_missing", detail: "this proposal has no path to re-observe" };

        // Already standing? Refuse TRUTHFULLY rather than chaining a silent
        // duplicate admission commit (review F2: a failed projection update
        // left the pane offering Admit again, and the second gesture passed
        // every policy row). The refusal also retries the projection catch-up
        // so the pane self-heals instead of offering the button forever.
        try {
          preHead = await currentStanding();
          preHeadKnown = true;
        } catch {
          preHead = null;
        }
        if (preHead !== null) {
          const headClaim = await claims.byId(preHead);
          if (headClaim && headClaim.subjectDigest.value === proposal.subjectDigest.value) {
            try {
              await deps.proposals.setVerification(proposalId, "passed", now());
              await deps.proposals.markAdmitted(proposalId, headClaim.id, now());
            } catch {
              /* projection remains behind; the refusal below still tells the truth */
            }
            return { ok: false, code: "already_admitted", detail: `this exact subject already stands as claim ${headClaim.id}; nothing further to admit` };
          }
        }

        // RE-OBSERVE AT CLICK TIME (review-and-safety: "a changed item aborts
        // admission rather than shrinking or expanding the decision
        // silently"): the click-time subject carries the CURRENT bytes'
        // digest; any edit since the proposal changes the digest and the
        // policy refuses with subject_drift.
        const current = await deps.readNoteBytes(proposal.subject.path);
        if (current === null) return { ok: false, code: "note_missing", detail: `${proposal.subject.path} no longer exists (D06: a disappearance is a fact; the proposal stays proposed)` };
        const { schema, ...rest } = proposal.subject;
        void schema;
        const clickSubject = buildProposalItemSubject({ ...rest, proposed: digestBytes(current) });

        subjectProposal.set(clickSubject, proposal);
        const { claim } = await service.admit({ proposal, subject: clickSubject, authority: { kind: "human-gesture", gestureRef } });

        // Projections catch up; failures degrade (D05).
        try {
          await deps.proposals.setVerification(proposalId, "passed", now());
          await deps.proposals.markAdmitted(proposalId, claim.id, now());
        } catch (e) {
          console.error("[governor] proposal projection update after admission failed (rebuildable)", e);
        }

        return {
          ok: true,
          claimId: claim.id,
          degraded: false,
          receipt: {
            subjectDigest: claim.subjectDigest.value,
            predicates: proposal.subject.predicates.map((p) => `${p.id}@${p.version}`),
            verifier: "governor content-diff@1 (deterministic, run at admission)",
            coverage: "exact-and-total",
          },
        };
      } catch (e) {
        if (e instanceof AdmissionRefusedError) return { ok: false, code: e.code, detail: e.message };
        if (e instanceof RefCasError) return { ok: false, code: e.code, detail: "standing moved during this admission; re-open the pane and decide again" };
        // A throw AFTER the CAS is the degraded window: the claim may stand
        // while the settlement record is missing. The discriminator is
        // MOVEMENT (review F1): standing must have advanced DURING THIS CALL
        // to a claim for this subject — a pre-existing claim with a matching
        // digest means this act never happened, and that case is answered by
        // the already_admitted refusal above, never by a degraded success
        // that would attribute a failed act to a prior admission.
        try {
          const head = await currentStanding();
          if (preHeadKnown && head !== null && head !== preHead) {
            const claim = await claims.byId(head);
            const proposal = await deps.proposals.get(proposalId);
            if (claim && proposal && claim.subjectDigest.value === proposal.subjectDigest.value) {
              return {
                ok: true,
                claimId: head,
                degraded: true,
                receipt: {
                  subjectDigest: claim.subjectDigest.value,
                  predicates: proposal.subject.predicates.map((p) => `${p.id}@${p.version}`),
                  verifier: "governor content-diff@1 (deterministic, run at admission)",
                  coverage: "exact-and-total",
                },
              };
            }
          }
        } catch {
          /* fall through to the plain failure */
        }
        return { ok: false, code: "admission_error", detail: e instanceof Error ? e.message : String(e) };
      }
    },

    async revertToBase(proposalId, gestureRef) {
      try {
        if (!gestureRef) return { ok: false, code: "authority_missing", detail: "revert is a human act" };
        const proposal = await deps.proposals.get(proposalId);
        if (!proposal) return { ok: false, code: "proposal_unknown", detail: `no proposal ${proposalId}` };
        if (proposal.authority !== "proposed") return { ok: false, code: "proposal_not_proposed", detail: `the proposal is ${proposal.authority}` };
        if (proposal.subject.path === null) return { ok: false, code: "path_missing", detail: "no path to revert" };
        // A creation's recorded base is NON-EXISTENCE. Writing an empty file
        // would misdescribe it (review F3: "the recorded base bytes" would be
        // a lie), and deletion machinery is the structural action's territory
        // — so this refuses with the honest code until that action exists.
        if (proposal.subject.base === null) {
          return { ok: false, code: "creation_revert_unsupported", detail: "this proposal created the note; its base is non-existence, and deleting is a structural act this surface does not perform" };
        }
        const base = await baseBytesOf(proposal);
        if (base === null) {
          return { ok: false, code: "base_unavailable", detail: "the recorded base cannot be read back; refusing a guessed revert" };
        }
        // The recording is VERIFIED against the subject before anything is
        // written (review F7): if the ref chain ever grows past the
        // producer's two commits, "oldest of the last 10" could be the wrong
        // commit, and a revert writing wrong bytes while saying "the
        // recorded base" is the exact confident-wrong-answer class.
        if (digestBytes(base).value !== proposal.subject.base.value) {
          return { ok: false, code: "base_mismatch", detail: "the recording's base does not digest to the subject's base; refusing rather than reverting to the wrong bytes" };
        }
        // D06: the revert WRITES NEW bytes through the ordinary machinery —
        // new history, a new subject if anything proposes it — and the
        // rejected result stays preserved in the recording ref. Nothing is
        // rewritten.
        await deps.writeNoteBytes(proposal.subject.path, base);
        try {
          await deps.proposals.supersede(proposalId, now());
        } catch (e) {
          // The bytes ARE back; only the projection failed. The receipt must
          // say what ran (review F4) — a plain "not reverted" would deny a
          // mutation that happened.
          return { ok: false, code: "revert_partial", detail: `the base bytes were written back, but the proposal could not be superseded (${e instanceof Error ? e.message : String(e)}); a later Admit will refuse with subject_drift` };
        }
        return { ok: true, supersededProposalId: proposalId };
      } catch (e) {
        return { ok: false, code: "revert_error", detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

/** Walk a (possibly nested) tree to a file's bytes; null when absent. */
export async function readFileFromTree(repo: HistoryRepository, treeOid: ObjectId, filePath: string): Promise<Uint8Array | null> {
  const segments = filePath.split("/");
  let tree = await repo.readTree(treeOid);
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = tree.find((e) => e.path === segments[i] && e.type === "tree");
    if (!dir) return null;
    tree = await repo.readTree(dir.oid);
  }
  const file = tree.find((e) => e.path === segments[segments.length - 1] && e.type === "blob");
  if (!file) return null;
  return repo.readBlob(file.oid);
}

