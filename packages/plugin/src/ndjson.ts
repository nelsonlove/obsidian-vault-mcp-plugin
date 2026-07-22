// Newline-delimited-JSON framing — the single source of truth for splitting a
// byte stream into complete lines, shared by the reconnect bridge
// (bridge/bridge.ts) and the per-connection server transport
// (socket-transport.ts) so the two can't diverge on a `\r\n` / empty-line edge.
// Pure and dependency-free, so esbuild inlines it into each bundle without
// pulling anything else across the bridge/plugin boundary.
//
// Accumulates `buffer` (the carried partial line from the previous chunk) with
// `chunk`, returns the complete lines (trailing `\r` stripped, blank AND
// whitespace-only lines dropped) and the new partial `rest` to carry forward.
// Dropping whitespace-only lines — not just empty ones — matches the server
// transport's original per-line skip so a padded/blank frame never reaches
// JSON.parse and surfaces a spurious error. (JSON with incidental surrounding
// whitespace still parses, since the line content itself is left untrimmed.)
export function splitLines(
  buffer: string,
  chunk: string
): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts
      .map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
      .filter((l) => l.trim().length > 0),
    rest,
  };
}
