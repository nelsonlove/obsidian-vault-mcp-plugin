import { posix } from "node:path";
// import ok separately (okError uses it in its body); re-export exposes ok/fail as this module's public API
import { ok } from "@vault-mcp/core";
export { ok, fail } from "@vault-mcp/core";

/**
 * Extract path keys from a `getBacklinksForFile()` data payload. Obsidian
 * builds differ: some return a `Map<string, …>`, others return a plain object.
 * Handles both shapes defensively so `getBacklinks` never throws.
 */
export function backlinkKeys(data: unknown): string[] {
  if (data instanceof Map) return [...(data as Map<string, unknown>).keys()];
  if (data !== null && data !== undefined && typeof data === "object") return Object.keys(data);
  return [];
}

// ok()'s shape plus the MCP error flag: for batch tools whose structured
// per-item report must survive a total failure (fail() would flatten it to text).
export function okError(data: unknown) {
  return { ...ok(data), isError: true as const };
}

// Static validation for a batch of moves, all checked before any item runs.
// Sequential batch moves make swaps/chains destructive with overwrite=true (an
// earlier item can trash or consume a note a later item depends on), and
// mid-batch input errors would leave the vault partially mutated — so any
// statically-detectable problem rejects the whole batch up front. Paths are
// normalized before comparison so './' and '..' aliases can't slip past
// (mirrors guardCall's normalize-before-compare).
export function validateMoves(moves: Array<{ from: string; to: string }>): string | null {
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from: rawFrom, to: rawTo } of moves) {
    if (!rawFrom.endsWith(".md")) return `source must end in .md: ${rawFrom}`;
    if (!rawTo.endsWith(".md")) return `destination must end in .md: ${rawTo}`;
    const from = posix.normalize(rawFrom);
    const to = posix.normalize(rawTo);
    if (from === to) return `from and to are the same path: ${rawFrom}`;
    if (froms.has(from)) return `duplicate source: ${rawFrom}`;
    if (tos.has(to)) return `duplicate destination: ${rawTo}`;
    froms.add(from);
    tos.add(to);
  }
  for (const f of froms) if (tos.has(f)) return `path is both a source and a destination: ${f}`;
  return null;
}
