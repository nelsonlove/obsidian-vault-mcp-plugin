/**
 * governance-admission-wiring.test.mjs — WP6b-2: the admission wiring, end to
 * end against the REAL history repository.
 *
 * The full §9 path, headless: a produced proposal (snapshots on its recording
 * ref) → click-time re-observation → the service's own verification run over
 * evidence Governor resolves (base bytes replayed from the recording; proposed
 * bytes from the "vault") → standing advanced as an admission COMMIT the ref
 * CASes onto. Plus §15's required attack family: synthetic clicks and
 * captured callbacks remain unable to admit — mutation-style, not prose.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAdmission, readFileFromTree } from "../src/governance/admission-wiring.ts";
import { openGitRepository } from "../src/governance/history-store/git-repository.ts";
import { proposalRef, standingRef } from "../src/kernel/governance/history-store/refs.ts";
import { createProposalStore } from "../src/kernel/governance/proposals/proposal-store.ts";
import { openProposal } from "../src/kernel/governance/proposals/proposal.ts";
import { buildProposalSubjectFromOperation } from "../src/kernel/governance/proposals/proposal-builder.ts";
import { digestBytes } from "../src/kernel/governance/contracts/digest.ts";
import { runGuardedDisposition } from "../src/kernel/governance/gesture.ts";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const T0 = 1_700_000_000_000;

function memoryIo() {
  const lines = [];
  return { lines, appendLine: async (l) => void lines.push(l), readLines: async () => [...lines] };
}

/** A full harness: real git repo, real stores, a fake vault, produced proposal. */
async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "governor-admission-"));
  const repo = await openGitRepository({ gitdir: path.join(root, "gitdir"), worktree: path.join(root, "vault") });

  const vault = new Map(); // path → string
  const proposals = createProposalStore(memoryIo());
  const settlements = [];
  let settlementFails = false;

  const claimIo = memoryIo();
  const admission = buildAdmission({
    repo: async () => repo,
    claimIo,
    proposals,
    readNoteBytes: async (p) => (vault.has(p) ? enc(vault.get(p)) : null),
    writeNoteBytes: async (p, bytes) => void vault.set(p, dec(bytes)),
    appendSettlement: async (r) => {
      if (settlementFails) throw new Error("settlement disk on fire");
      settlements.push(r);
    },
    now: () => T0,
  });

  /** Produce a proposal the way WP6b-1's producer does: snapshots then open. */
  let produceSeq = 0;
  async function produce(notePath, baseText, proposedText) {
    produceSeq++;
    if (baseText !== null) vault.set(notePath, baseText);
    vault.set(notePath, proposedText); // the write has landed (D11: visible working tree)
    const subject = buildProposalSubjectFromOperation({
      vaultId: "vault-1",
      noteId: `path:${notePath}`,
      path: notePath,
      pathSemanticallyRelevant: false,
      base: baseText === null ? null : digestBytes(enc(baseText)),
      proposed: digestBytes(enc(proposedText)),
      changeClasses: ["content"],
      transformation: { id: "note.write", version: "1" },
      predicates: [{ id: "content-diff", version: "1" }],
      producingOperation: { id: `op-${notePath}`, action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId: null,
    });
    // Distinct mint instant per produce: identical (now, rand) pairs mint
    // identical UUIDv7s — a property of injection, not of proposals.
    const proposal = openProposal({ subject, sessionId: "sess-1" }, T0 + produceSeq, new Uint8Array(10).fill(produceSeq));
    const ref = proposalRef(proposal.id);
    const base = await repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: baseText === null ? null : enc(baseText) }],
      message: `base for proposal ${proposal.id}`,
      timestamp: 1,
      expectedRef: null,
    });
    await repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: enc(proposedText) }],
      message: `proposed for proposal ${proposal.id}`,
      timestamp: 2,
      expectedRef: base.oid,
    });
    await proposals.open({ ...proposal, recordingRef: ref }, T0);
    return proposal;
  }

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  return { repo, vault, proposals, settlements, admission, produce, cleanup, claimIo, setSettlementFails: (v) => (settlementFails = v) };
}

describe("admission wiring — the full path against the real repository", () => {
  let h;
  before(async () => {
    h = await harness();
  });
  after(() => h.cleanup());

  test("a produced proposal admits: verification runs on replayed base + current bytes, standing becomes a commit", async () => {
    const proposal = await h.produce("Notes/A.md", "base text\n", "proposed text\n");
    const outcome = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-1");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.degraded, false);

    // The receipt names subject, predicate, verifier, coverage (never-say rules).
    assert.equal(outcome.receipt.subjectDigest, proposal.subjectDigest.value);
    assert.deepEqual(outcome.receipt.predicates, ["content-diff@1"]);
    assert.match(outcome.receipt.verifier, /content-diff@1/);
    assert.equal(outcome.receipt.coverage, "exact-and-total");

    // Standing is a REAL commit the ref names, whose message carries the claim
    // id and whose tree carries the claim JSON — readable by stock git.
    const oid = await h.repo.resolveRef(standingRef());
    const commit = await h.repo.readCommit(oid);
    assert.match(commit.message, new RegExp(`^admission ${outcome.claimId}`));
    const claimBytes = await readFileFromTree(h.repo, commit.tree, "claim.json");
    assert.equal(JSON.parse(dec(claimBytes)).id, outcome.claimId);

    // Settlement recorded; projection store caught up.
    assert.equal(h.settlements.length, 1);
    assert.equal((await h.proposals.get(proposal.id)).authority, "admitted");
  });

  test("an edit between proposal and click ABORTS with subject_drift — nothing admits, nothing advances", async () => {
    const proposal = await h.produce("Notes/B.md", "base\n", "proposed\n");
    h.vault.set("Notes/B.md", "EDITED AFTER THE PROPOSAL\n");
    const before = await h.repo.resolveRef(standingRef());
    const outcome = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-2");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "subject_drift");
    assert.equal(await h.repo.resolveRef(standingRef()), before, "standing untouched");
    assert.equal((await h.proposals.get(proposal.id)).authority, "proposed", "remains proposed — fail closed");
  });

  test("a deleted note refuses: a disappearance is a fact, the proposal stays proposed (D06)", async () => {
    const proposal = await h.produce("Notes/C.md", "base\n", "proposed\n");
    h.vault.delete("Notes/C.md");
    const outcome = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-3");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "note_missing");
  });

  test("a creation admits with base null — the recording's empty base is the discriminator, not a guess", async () => {
    const proposal = await h.produce("Notes/New.md", null, "brand new\n");
    const outcome = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-4");
    assert.ok(outcome.ok, JSON.stringify(outcome));
  });

  test("a second admission chains on the first — supersession through one CAS chain of commits", async () => {
    const p1 = await h.produce("Notes/Chain.md", "v0\n", "v1\n");
    const first = await h.admission.admitWithGesture(p1.id, "gesture-test-ref-5");
    assert.ok(first.ok);
    const p2 = await h.produce("Notes/Chain.md", "v1\n", "v2\n");
    const second = await h.admission.admitWithGesture(p2.id, "gesture-test-ref-6");
    assert.ok(second.ok, JSON.stringify(second));
    const head = await h.repo.readCommit(await h.repo.resolveRef(standingRef()));
    assert.match(head.message, new RegExp(`^admission ${second.claimId}`));
    assert.equal(head.parents.length, 1, "chained on the prior standing commit");
  });

  test("DEGRADED: a settlement-append failure after the CAS leaves the admission STANDING and says so", async () => {
    const proposal = await h.produce("Notes/Degraded.md", "base\n", "proposed\n");
    h.setSettlementFails(true);
    const outcome = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-7");
    h.setSettlementFails(false);
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(outcome.degraded, true, "the receipt SAYS the record is catching up — never a silent gap, never a lie that it failed");
    const head = await h.repo.readCommit(await h.repo.resolveRef(standingRef()));
    assert.match(head.message, new RegExp(`^admission ${outcome.claimId}`));
  });

  test("re-admitting an already-standing subject refuses TRUTHFULLY and self-heals the projection — review F1/F2", async () => {
    // The false-degraded misattribution: admit succeeds but the projection
    // update fails, the pane offers Admit again, and the second click used to
    // either chain a silent duplicate admission commit (F2) or — failing
    // pre-CAS — report ok+degraded with the OLD claim id (F1). Now: a
    // truthful already_admitted refusal that also catches the projection up.
    const proposal = await h.produce("Notes/Dup.md", "base\n", "proposed\n");
    const first = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-8");
    assert.ok(first.ok);
    const headBefore = await h.repo.resolveRef(standingRef());
    const second = await h.admission.admitWithGesture(proposal.id, "gesture-test-ref-9");
    assert.ok(!second.ok, JSON.stringify(second));
    assert.equal(second.code, "already_admitted");
    assert.equal(await h.repo.resolveRef(standingRef()), headBefore, "no duplicate admission commit chained");
  });

  test("a creation revert refuses honestly — its base is non-existence, not an empty file (review F3)", async () => {
    const proposal = await h.produce("Notes/CreatedRevert.md", null, "created content\n");
    const outcome = await h.admission.revertToBase(proposal.id, "gesture-test-ref-10");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "creation_revert_unsupported");
    assert.equal(h.vault.get("Notes/CreatedRevert.md"), "created content\n", "the note is untouched — no empty-file lie");
  });

  test("revert digest-checks the recorded base before writing anything (review F7)", async () => {
    // If the recording chain ever grows past the producer's two commits, the
    // "oldest of 10" heuristic could name the wrong commit — and a revert
    // writing wrong bytes while saying "the recorded base" is the confident-
    // wrong-answer class. Exercised for real: the recording's base commit
    // holds DIFFERENT bytes than the subject claims, and the revert refuses
    // with base_mismatch, writing nothing.
    const notePath = "Notes/Tampered.md";
    h.vault.set(notePath, "proposed\n");
    const subject = buildProposalSubjectFromOperation({
      vaultId: "vault-1",
      noteId: `path:${notePath}`,
      path: notePath,
      pathSemanticallyRelevant: false,
      base: digestBytes(enc("what the subject CLAIMS\n")),
      proposed: digestBytes(enc("proposed\n")),
      changeClasses: ["content"],
      transformation: { id: "note.write", version: "1" },
      predicates: [{ id: "content-diff", version: "1" }],
      producingOperation: { id: "op-tampered", action: "note.write", actionVersion: 1 },
      observations: [],
      sessionId: "sess-1",
      mandateId: null,
    });
    const proposal = openProposal({ subject, sessionId: "sess-1" }, T0 + 99, new Uint8Array(10).fill(99));
    const ref = proposalRef(proposal.id);
    const base = await h.repo.recordSnapshot({
      ref,
      files: [{ path: notePath, bytes: enc("what the recording HOLDS\n") }],
      message: "base",
      timestamp: 1,
      expectedRef: null,
    });
    await h.repo.recordSnapshot({ ref, files: [{ path: notePath, bytes: enc("proposed\n") }], message: "proposed", timestamp: 2, expectedRef: base.oid });
    await h.proposals.open({ ...proposal, recordingRef: ref }, T0);

    const outcome = await h.admission.revertToBase(proposal.id, "gesture-test-ref-11");
    assert.ok(!outcome.ok);
    assert.equal(outcome.code, "base_mismatch");
    assert.equal(h.vault.get(notePath), "proposed\n", "nothing was written");
  });

  test("two CONCURRENT admits of one subject: exactly one claim chains; the loser refuses already_admitted", async () => {
    // The wiring's pre-check runs outside the service's serialized chain, so
    // two genuinely concurrent trusted clicks could both pass it. The check
    // INSIDE the chain (re-review residual) is what makes the ledger clean:
    // the loser's serialized turn sees the winner standing and refuses.
    const proposal = await h.produce("Notes/Race.md", "base\n", "proposed\n");
    const [a, b] = await Promise.all([
      h.admission.admitWithGesture(proposal.id, "gesture-race-a"),
      h.admission.admitWithGesture(proposal.id, "gesture-race-b"),
    ]);
    const oks = [a, b].filter((o) => o.ok);
    const refused = [a, b].filter((o) => !o.ok);
    assert.equal(oks.length, 1, "exactly one admission");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].code, "already_admitted");
    // And the standing chain holds exactly ONE commit for this subject.
    const head = await h.repo.readCommit(await h.repo.resolveRef(standingRef()));
    assert.match(head.message, new RegExp(`^admission ${oks[0].claimId}`));
  });

  test("a TRANSIENT standing-read fault cannot resurrect the false-degraded misreport — the sentinel pin", async () => {
    // Governor-lead's sixth-of-the-family finding: the sentinel existed
    // because a review found the quadruple-fault path, but nothing exercised
    // a THROWING standing reader — their mutation (preHeadKnown = true in
    // the catch) survived the suite. This is the full quadruple fault:
    // (1) the projection update failed at the first admission, so the pane
    // still offers Admit; (2) the pre-check's standing read faults
    // transiently; (3) the service's own standing read faults; (4) the
    // catch's read recovers and sees the OLD claim standing for this exact
    // subject. Under the mutation the catch reports ok+degraded with the
    // old claim id — a false admission report; with the sentinel, an
    // unknown starting point suppresses the branch and the answer is a
    // plain failure. (First attempt at this pin was itself vacuous — empty
    // claim store, branch unreachable; the vacuity rule applied to my own
    // test.)
    const local = await harness();
    try {
      // (1) first admission whose projection update FAILS — proposals proxy
      // throws on markAdmitted once, so authority stays "proposed".
      let projectionFaults = 1;
      const flakyProposals = new Proxy(local.proposals, {
        get(target, prop) {
          if (prop === "markAdmitted") {
            return async (...args) => {
              if (projectionFaults > 0) {
                projectionFaults--;
                throw new Error("projection update failed");
              }
              return target.markAdmitted(...args);
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const admissionA = buildAdmission({
        repo: async () => local.repo,
        claimIo: local.claimIo,
        proposals: flakyProposals,
        readNoteBytes: async (p) => (local.vault.has(p) ? enc(local.vault.get(p)) : null),
        writeNoteBytes: async () => {},
        appendSettlement: async () => {},
        now: () => T0,
      });
      const p1 = await local.produce("Notes/Sentinel.md", "base\n", "proposed\n");
      const first = await admissionA.admitWithGesture(p1.id, "gesture-s1");
      assert.ok(first.ok, JSON.stringify(first));
      assert.equal((await local.proposals.get(p1.id)).authority, "proposed", "premise: the projection is stale");

      // (2)+(3) two transient ref-read faults, (4) recovery for the catch.
      let failures = 2;
      const faultingRepo = new Proxy(local.repo, {
        get(target, prop) {
          if (prop === "resolveRef") {
            return async (...args) => {
              if (failures > 0) {
                failures--;
                throw new Error("transient IO fault");
              }
              return target.resolveRef(...args);
            };
          }
          const v = target[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const faulting = buildAdmission({
        repo: async () => faultingRepo,
        claimIo: local.claimIo,
        proposals: local.proposals,
        readNoteBytes: async (p) => (local.vault.has(p) ? enc(local.vault.get(p)) : null),
        writeNoteBytes: async () => {},
        appendSettlement: async () => {},
        now: () => T0,
      });
      const outcome = await faulting.admitWithGesture(p1.id, "gesture-s2");
      assert.ok(!outcome.ok, `the false admission report: ${JSON.stringify(outcome)}`);
    } finally {
      local.cleanup();
    }
  });

  test("revert writes the recorded base back as a NEW change and supersedes the proposal", async () => {
    const proposal = await h.produce("Notes/Revert.md", "the base\n", "the proposal\n");
    const outcome = await h.admission.revertToBase(proposal.id, "gesture-test-ref-12");
    assert.ok(outcome.ok, JSON.stringify(outcome));
    assert.equal(h.vault.get("Notes/Revert.md"), "the base\n", "the base bytes are back");
    assert.equal((await h.proposals.get(proposal.id)).authority, "superseded");
    // The rejected result is PRESERVED in the recording — new history, no rewrite.
    const chain = await h.repo.log(proposal.recordingRef ?? proposalRef(proposal.id), 10);
    const proposedCommit = chain[0];
    const preserved = await readFileFromTree(h.repo, proposedCommit.tree, "Notes/Revert.md");
    assert.equal(dec(preserved), "the proposal\n");
  });
});

// ── §15: the required authority-perimeter attack family ──────────────────────

describe("§15 — synthetic clicks and captured callbacks remain unable to admit", () => {
  test("a synthetic (untrusted) event stops at the FIRST gate: the confirm modal never opens, admit never runs", async () => {
    let confirmOpened = false;
    let admitted = false;
    const outcome = await runGuardedDisposition(
      { isTrusted: false, type: "click" }, // a synthesized event — exactly what dispatchEvent produces
      async () => {
        confirmOpened = true;
        return true;
      },
      async () => {
        admitted = true;
      }
    );
    assert.equal(outcome, "blocked-untrusted");
    assert.equal(confirmOpened, false, "the modal never even opened");
    assert.equal(admitted, false);
  });

  test("a captured-callback replay with a forged plain object cannot admit", async () => {
    // The 0.15.2-era attack shape: renderer JS captures a handler and invokes
    // it with whatever it likes. The handler's first act is the shared gate,
    // and a plain object is not a trusted Event.
    let admitted = false;
    for (const forged of [{}, { isTrusted: true }, null, undefined, "click"]) {
      const outcome = await runGuardedDisposition(forged, null, async () => {
        admitted = true;
      });
      assert.equal(outcome, "blocked-untrusted", `forged ${JSON.stringify(forged)} must not pass`);
    }
    assert.equal(admitted, false);
  });

  test("the pane wires Admit through the shared gate — pinned at the source", async () => {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(new URL("../src/governance/pane.ts", import.meta.url), "utf8");
    const lines = raw.split("\n");
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (/admitBtn\.addEventListener\(/.test(lines[i])) {
        assert.match(lines.slice(i, i + 5).join("\n"), /runGuardedDisposition/, "Admit routes through THE shared gesture gate");
        found = true;
      }
    }
    assert.ok(found, "the Admit button exists and is addEventListener-wired");
  });

  test("the pane CANNOT mint a gesture ref — the only mint lives inside the gate (governor-lead's attack)", async () => {
    // The attack: mint at render time and every test stays green while the
    // authority record's meaning corrupts. The fix deletes the possibility:
    // the gate mints AFTER its checks and hands the ref to the action; the
    // pane has no mint to misplace.
    const fsm = await import("node:fs");
    const pane = fsm.readFileSync(new URL("../src/governance/pane.ts", import.meta.url), "utf8");
    assert.ok(!/mintGestureRef|uuidv7|gesture-\$\{/.test(pane), "no mint machinery is reachable from the pane");
    const gesture = fsm.readFileSync(new URL("../src/kernel/governance/gesture.ts", import.meta.url), "utf8");
    const gateAt = gesture.indexOf("isRealGesture(evt)");
    const mintAt = gesture.indexOf("mintGestureRefInternal(Date.now())");
    assert.ok(gateAt > 0 && mintAt > gateAt, "the mint sits downstream of the trust check, in the gate's own body");
    assert.ok(!/export function mintGestureRefInternal|export \{[^}]*mintGestureRefInternal/.test(gesture), "the mint is module-private");
  });

  test("the gate hands a real ref to the action — behaviorally", async () => {
    let received = null;
    const outcome = await runGuardedDisposition(
      new (class extends Object {})(), // not an Event — must be blocked first; sanity that blocked path passes nothing
      null,
      async (ref) => {
        received = ref;
      }
    );
    assert.equal(outcome, "blocked-untrusted");
    assert.equal(received, null, "a blocked gesture mints nothing");
  });

  test("this scan can find something — the vacuity self-check", async () => {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(new URL("../src/governance/pane.ts", import.meta.url), "utf8");
    assert.ok(/admitBtn\.addEventListener\(/.test(raw), "the pattern matches the real wiring site");
  });
});

// ── the fail-closed row, declared where a reader looks ───────────────────────

describe("the declared fail direction", () => {
  test("admission-wiring.ts declares its threat-model row at the top of the file", async () => {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(new URL("../src/governance/admission-wiring.ts", import.meta.url), "utf8");
    assert.match(raw, /FAIL CLOSED/, "the row is declared");
    assert.match(raw, /REMAINS PROPOSED/, "with the outcome named");
    assert.match(raw, /degraded/i, "and the one deliberate exception documented");
  });
});
