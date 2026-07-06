export function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

export function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true as const };
}

// Sequential batch moves make swaps/chains destructive with overwrite=true (an
// earlier item can trash or consume a note a later item depends on), so an
// internally-conflicting batch is rejected before any item runs.
export function batchMoveConflicts(moves: Array<{ from: string; to: string }>): string | null {
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from, to } of moves) {
    if (froms.has(from)) return `duplicate source: ${from}`;
    if (tos.has(to)) return `duplicate destination: ${to}`;
    froms.add(from);
    tos.add(to);
  }
  for (const f of froms) if (tos.has(f)) return `path is both a source and a destination: ${f}`;
  return null;
}
