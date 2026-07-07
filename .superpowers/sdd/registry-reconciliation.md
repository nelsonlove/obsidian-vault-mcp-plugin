# Best-of-both registry reconciliation (governs the Task 6 redo + Task 7)

The shared FS_TOOLS registry is the SUPERSET / most-accurate choice per tool.
Baseline = current HEAD (server schemas). Apply these deltas.

## Schema (structural)
- **obsidian_resolve**: KEEP server's `refs: z.array(z.string().min(1)).min(1).max(100)`
  (batch). ADD BACK the plugin's `from: z.string().optional()` (context for
  relative-link disambiguation). FS backend ignores `from` gracefully for now
  (folder-relative resolution is a documented follow-up); plugin honors it.
  Description must say `from` is best-effort / backend-dependent.
- **obsidian_move_note**: KEEP server's `update_backlinks: z.boolean().default(true)`
  + `overwrite: z.boolean().default(false)`. FS honors update_backlinks; the
  plugin always rewrites via Obsidian (field is a documented no-op there).

## Annotations (adopt the accurate/safer = server's; HEAD already correct)
- patch_note, write_note, move_note → DESTRUCTIVE (can overwrite/replace/destroy).
- force_reindex → readOnlyHint:true, idempotentHint:true. Reindex reads the vault and
  rebuilds the in-memory index; it never mutates vault data. Must be read-only so the
  plugin's guardCall does not block it in read-only mode.
- Everything else unchanged.

## Descriptions (server's richer text, but backend-NEUTRAL + accurate)
Server descriptions are more useful to the LLM — adopt them, but EDIT OUT
FS-backend-specific claims that are false for the live plugin:
- Remove "in-memory index / built at startup / ~300ms refresh" phrasing from
  get_backlinks, search_by_frontmatter, move_note, manage_frontmatter — phrase
  neutrally (e.g. "resolved from the vault index" without implementation/timing).
- delete_note: drop the specific incident date (2026-06-04); keep the safety rationale.
- force_reindex: one backend-neutral description — "Rebuilds the vault index on
  backends that maintain one; a no-op on backends whose cache is always live."
- Keep server's regex error messages on property/key (real improvements).
- Titles: adopt the clearer server titles.

## Downstream (Task 7 — plugin adopts this registry)
- Plugin `obsidian_resolve` handler must accept `refs: string[]` (loop its single
  Obsidian resolver, applying `from`) — a field rename ref→refs on the LIVE tool.
- Plugin gains `update_backlinks` (ignored) + the new DESTRUCTIVE annotations.
- These are the accepted live-API changes of "best of both" (sole user).
