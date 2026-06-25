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

// Shape-compatible with the 92046 VPS server's index_status. Obsidian's
// metadataCache is always live, so status is permanently "ready" and
// last_built_at reflects "current as of this call".
export function liveIndexStatus(app: import("obsidian").App) {
  return {
    status: "ready" as const,
    count: app.vault.getMarkdownFiles().length,
    last_built_at: new Date().toISOString(),
  };
}
