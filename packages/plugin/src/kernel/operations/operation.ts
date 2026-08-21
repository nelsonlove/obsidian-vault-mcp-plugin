// The OPERATION envelope — Gate 0, WP1 (D15).
//
// An action is a contract. An OPERATION is one invocation of it: this caller,
// these inputs, this moment, this outcome. D15 settles that EVERY invocation is
// an operation — reads, plans, mutations, verification and authority alike —
// with durability chosen separately, so ordinary plumbing does not become a
// permanent log merely because it passed through the kernel.
//
// One contract for all of them is what makes the seam worth having. Two
// routers, one for reads and one for writes, put a boundary exactly where
// evidence has to stay traceable: reads already feed plans, previews,
// verification and scope enforcement, so a read that cannot be linked to the
// mutation it informed is a hole in the chain rather than a saving.
//
// This module is pure data and types. Nothing here writes, queues or logs.

import type { SurfaceKind } from "./action.js";

/**
 * The canonical phase order.
 *
 * An operation activates ONLY the phases its action requires, and the envelope
 * records exactly those. A read that closes after producing a result must not
 * carry an `attempted` phase; claiming a phase that did not happen is how a
 * receipt comes to describe work nobody did.
 */
export const OPERATION_PHASES = [
  "received",
  "resolved",
  "observed",
  "planned",
  "authorized",
  "queued",
  "attempted",
  "effects-observed",
  "verified",
  "proposed",
  "admitted",
  "receipt-produced",
  "closed",
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

/**
 * How an operation ended.
 *
 * `refused`, `conflict` and `deduplicated` are all NOT-completed but are not
 * failures either, and the difference is what a caller needs in order to know
 * whether to retry. `uncertain` is the one that matters most: it means the
 * intended mutation may or may not have landed, and the only safe next step is
 * to re-read.
 */
export const OPERATION_OUTCOMES = [
  "completed",
  "refused",
  "conflict",
  "deduplicated",
  "partial",
  "uncertain",
  "failed",
] as const;
export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

export interface OperationActor {
  /**
   * Governor-derived binding for the connection or gesture that invoked this.
   * NEVER supplied by the caller — a client that sends an `actor` field is
   * ignored, and an action that declares one fails the registry's
   * `caller_supplied_identity` check.
   */
  binding: string;
  /** The client's self-asserted label. Descriptive; never authentication. */
  clientClaim: string | null;
}

export interface OperationV1 {
  schema: "governor.operation/v1";
  id: string;
  action: { id: string; version: number };
  surface: { kind: SurfaceKind; id: string };
  actor: OperationActor;
  sessionId: string | null;
  mandateId: string | null;
  /**
   * A digest of the normalized inputs — NOT the inputs. The operation record is
   * metadata; a digest that embedded content would make every envelope a copy
   * of the note, which is the mistake the write journal's `digestArgs` already
   * avoids.
   *
   * Non-cryptographic on purpose. This identifies and compares invocations; it
   * is not a signed subject. Canonical SHA-256 belongs to proposal and cohort
   * subjects (WP3), where a signature depends on every producer computing the
   * same bytes.
   */
  normalizedInputDigest: string;
  /** Digest of the effective scope this invocation ran under. */
  effectiveScopeDigest: string;
  /** The phase reached. */
  phase: OperationPhase;
  /** Every phase entered, in canonical order, with its timestamp. */
  phases: Array<{ phase: OperationPhase; at: number }>;
  /** Ids of durable observations this operation consumed. Empty until WP2. */
  observations: string[];
  plan: string | null;
  attemptedEffects: string[];
  /** Effects Governor independently OBSERVED, never handler claims. WP2. */
  observedEffects: string[];
  verification: string[];
  authority: string | null;
  proposalSubject: string | null;
  standingTransition: string | null;
  outcome: OperationOutcome | null;
  recovery: string | null;
}

/**
 * A non-cryptographic 64-bit FNV-1a digest, rendered hex.
 *
 * Deliberately not SHA-256, and deliberately labelled. The coding guide keeps
 * FNV as "a non-authoritative cache/diff optimization" — which is exactly what
 * an operation-identity digest is. Using it here also makes it impossible to
 * mistake an operation digest for a subject digest later: they do not even look
 * alike.
 */
export function nonAuthoritativeDigest(input: string): string {
  // 64-bit FNV-1a over two 32-bit halves, since JS bitwise ops are 32-bit.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c << 1) | (i & 1);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `fnv1a64:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Length beyond which a value is summarized rather than digested verbatim. */
const MAX_DIGESTED_VALUE = 200;

/**
 * Stable serialization of inputs for digesting.
 *
 * Keys are sorted, so argument order cannot change an operation's identity. Long
 * strings collapse to `<N chars>` — the same convention the write journal uses —
 * so a note body contributes its LENGTH and not its text. That means two
 * different bodies of equal length share a digest; acceptable here, because this
 * digest identifies an invocation for correlation, and nothing decides authority
 * from it.
 */
export function normalizeInputs(inputs: unknown): string {
  // Tracks the CURRENT PATH, not everything ever visited. A `WeakSet` that
  // only ever grows reports `<circular>` for the second of two keys that share
  // one object reference — `{a: x, b: x}` is aliasing, not a cycle — which
  // would make the digest depend on object identity rather than value. Two
  // callers passing equal-but-distinct objects would then digest differently
  // from one caller reusing a reference.
  const path = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v.length > MAX_DIGESTED_VALUE ? `<${v.length} chars>` : v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "bigint") return `${v}n`;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object") {
      if (path.has(v as object)) return "<circular>";
      path.add(v as object);
      try {
        // Objects with no own enumerable string keys would otherwise all
        // normalize to `{}` — every Date value collapsing to one digest, every
        // Map indistinguishable from every Set. MCP arguments arrive
        // JSON-parsed so this never bites there, but this executor is the seam
        // for Obsidian commands, pane gestures and internal calls too, where a
        // live object is perfectly plausible.
        if (v instanceof Date) return `<date:${Number.isNaN(v.getTime()) ? "invalid" : v.toISOString()}>`;
        if (v instanceof Map) return { "<map>": [...v.entries()].map(([k, val]) => [walk(k), walk(val)]) };
        if (v instanceof Set) return { "<set>": [...v.values()].map(walk) };
        const keys = Object.keys(v as Record<string, unknown>).sort();
        const out: Record<string, unknown> = {};
        for (const key of keys) out[key] = walk((v as Record<string, unknown>)[key]);
        if (keys.length === 0) {
          // A class instance with no own enumerable keys still has a shape
          // worth distinguishing from a bare `{}`.
          const name = (v as object).constructor?.name;
          if (name && name !== "Object") return `<${name}>`;
        }
        return out;
      } finally {
        path.delete(v as object);
      }
    }
    return String(v);
  };
  return JSON.stringify(walk(inputs));
}
