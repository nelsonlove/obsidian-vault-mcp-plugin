## Task 6 Report: Register server tools from the shared @vault-mcp/core registry

**Status:** DONE

---

### Commits (base d3f31e1…head)

Single commit: `refactor(server): register the 17 tools from the shared @vault-mcp/core registry`

---

### Build + test results

- `npm run build --workspace packages/core` — clean (0 errors)
- `npm run build --workspace packages/server` — clean (0 errors)
- `npm test --workspaces --if-present` — **129/129 pass** (56 core, 64 plugin, 9 server)

---

### What changed

**`packages/core/src/tool-registry.ts`**

Updated FS_TOOLS to be byte-identical to the server's previous inline schemas (public contract). Key structural changes:

- `obsidian_resolve`: changed from `ref` (single string) + `from` (optional) → `refs` (array, min 1, max 100). Matches the server's batch-resolution contract.
- `obsidian_move_note`: added `update_backlinks: z.boolean().default(true)` field — the server always supported it, FS_TOOLS was missing it.
- `obsidian_force_reindex`: updated annotations from `RO` to `{readOnlyHint: false, …idempotentHint: true}` — it's not read-only (mutates the in-memory index).
- `obsidian_patch_note`, `obsidian_write_note`, `obsidian_move_note`: annotations corrected from `RW` to `DESTRUCTIVE`.
- All titles, descriptions, and inputSchema `.describe()` strings updated to match the server's previous inline values exactly.

**`packages/core/src/register-fs-tools.ts`** (new)

Implements `registerFsTools(server, backend, opts?)`. Design decisions:

- `server` is typed as `any` (structural duck type documented in source) to avoid adding `@modelcontextprotocol/sdk` to core's deps — per the "core deps unchanged" constraint.
- `opts.includeIndexStatus`: typed as `() => IndexStatusSnapshot` (not generic `object`) so the `obsidian_force_reindex` handler can access `.status`/`.count`/`.last_built_at`/`.error` fields directly for the timing response.
- Handler dispatch is a `switch` on `tool.name` — explicit, type-safe, no magic.
- **Non-trivial handlers preserved exactly:**
  - `obsidian_force_reindex`: captures before-status, calls `await backend.forceReindex()`, captures after-status, returns `{status, prev_count, count, duration_ms, last_built_at, error}`.
  - `obsidian_read_notes`: uses `idx`-tagging + sort to preserve input order even with duplicate paths; checks `content.length > CHARACTER_LIMIT` for the `truncated` flag.
  - `obsidian_resolve`: splits `ResolveResult[]` into `resolved`/`ambiguous`/`unresolved` buckets.
  - `obsidian_patch_note`: block anchor validation (`/^[A-Za-z0-9_-]+$/`) before reaching backend.
  - `obsidian_manage_frontmatter`: op-based response shaping + "value required for set" guard.
  - `obsidian_find_by_tag`: strips `#` from tag in response.
  - `obsidian_search_by_frontmatter`: applies `limit` to backend's uncapped result set, computes `total`/`has_more` from full match count.

**`packages/core/src/index.ts`**

Added exports: `registerFsTools`, `RegisterFsToolsOpts`, `IndexStatusSnapshot`.

**`packages/server/src/index.ts`**

- Deleted all 17 inline `server.registerTool(...)` definitions (~550 lines removed).
- Added `makeBackend(): VaultBackend` — thin adapter that wraps the module-level singleton functions (`listNotes`, `readNote`, `buildIndex`, `indexStatus`, etc.) so they present through the `VaultBackend` interface. This preserves the existing module-level index and vault-watcher wiring — the watcher still updates the same index that `includeIndexStatus: indexStatus` reads.
- `buildServer()` now: `registerFsTools(server, makeBackend(), { decodeHtml: true, includeIndexStatus: indexStatus })`.
- HTTP/OAuth transport (`auth.ts`, `remote-proxy.ts`) and vault-watcher startup untouched.

**`packages/server/src/__tests__/register-fs-tools.test.ts`** (new)

9 tests via `McpServer` + `InMemoryTransport` + `Client`:
1. tools/list = 17 tools, names match FS_TOOLS
2. `obsidian_resolve` has `refs` (array), not `ref`; `obsidian_move_note` has `update_backlinks`
3. `obsidian_read_note` includes `index_status` when configured
4. `obsidian_read_note` omits `index_status` when not configured
5. `obsidian_read_notes` has `truncated` field per note
6. `obsidian_write_note` + `obsidian_read_note` round-trip
7. `obsidian_force_reindex` returns timing fields + calls backend
8. Missing note returns `isError: true`
9. `obsidian_manage_frontmatter` op=set without value returns error

---

### tools/list verification

tools/list count: **17** ✓  
Names (sorted): obsidian_append_note, obsidian_delete_note, obsidian_find_by_tag, obsidian_force_reindex, obsidian_get_backlinks, obsidian_get_outlinks, obsidian_list_folders, obsidian_list_notes, obsidian_manage_frontmatter, obsidian_move_note, obsidian_patch_note, obsidian_read_note, obsidian_read_notes, obsidian_resolve, obsidian_search_by_frontmatter, obsidian_search_notes, obsidian_write_note — all match FS_TOOLS exactly.  
Input schemas confirmed: `obsidian_resolve` has `refs` array (not `ref`), `obsidian_move_note` has `update_backlinks`.
