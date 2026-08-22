// STANDING HEALTH — #337 option 4, landed with WP8.
//
// §10 already makes one direction loud: a standing ref naming a claim the
// store cannot read is a critical health failure. This module makes the
// INVERSE loud too — claims exist but the chain is absent — because that
// failure is otherwise perfectly quiet: every claim survives, nothing
// corrupts, and the resolver answers "ungoverned … unattached evidence,
// nothing stands" for every admitted subject. Correct answer to the question
// asked; catastrophic answer to the question meant. The chain lives at
// historyDir() outside every backup (#337), so losing it is a real disk-loss
// mode, and a silent downgrade of all standing must surface as CRITICAL, not
// read as a clean empty vault.

import type { ClaimStore } from "./settlement.js";

export interface StandingHealthReport {
  status: "ok" | "critical";
  code: "healthy" | "empty" | "chain_absent" | "chain_unreadable";
  detail: string;
  claimCount: number;
  chainLength: number | null;
}

export async function standingHealth(deps: { claims: ClaimStore; standingChain: () => Promise<string[]> }): Promise<StandingHealthReport> {
  const claimCount = (await deps.claims.all()).length;

  let chain: string[];
  try {
    chain = await deps.standingChain();
  } catch (e) {
    // §10's own direction, surfaced with the same severity from this side.
    return {
      status: "critical",
      code: "chain_unreadable",
      detail: `the standing chain cannot be read: ${e instanceof Error ? e.message : String(e)}`,
      claimCount,
      chainLength: null,
    };
  }

  if (claimCount > 0 && chain.length === 0) {
    return {
      status: "critical",
      code: "chain_absent",
      detail:
        `${claimCount} admission claim(s) exist but the standing chain is empty — every admitted subject silently reads as ungoverned. ` +
        "This is the #337 disk-loss signature (the chain lives outside the vault and outside every backup), not a clean vault. " +
        "Do not treat resolver 'ungoverned' answers as truth until the chain is restored.",
      claimCount,
      chainLength: 0,
    };
  }

  if (claimCount === 0 && chain.length === 0) {
    return { status: "ok", code: "empty", detail: "no admissions yet — nothing stands and nothing claims to", claimCount, chainLength: 0 };
  }

  return { status: "ok", code: "healthy", detail: `${chain.length} admission(s) in the standing chain`, claimCount, chainLength: chain.length };
}
