## Task 7 Report: Plugin 17 fs-expressible tools → shared registry

**Status:** DONE_WITH_CONCERNS

**Commits:** `d419ffe`..`8480b2c`

**Build:** `npm run build --workspace packages/plugin` → clean, `main.js` 401.7 KB emitted (CJS via esbuild).

**Tests:** `npm test --workspaces --if-present` → all green.
- `@vault-mcp/core`: 59 pass, 0 fail
- `obsidian-vault-mcp-plugin`: 64 pass, 0 fail
- `obsidian-vault-mcp-server`: 9 pass, 0 fail

**Tool count:** Before = 38 base + up to 6 conditional integrations = 44 with all integrations. After = same 38 base (17 from registerFsTools + 2 core + 1 move_notes + 9 complementary + 9 nav) + same 6 conditional = 44. No tools added or dropped. Verified 44 unique `"obsidian_*"` strings in built `main.js`.

**guardCall wraps the 17:** The monkeypatch on `server.registerTool` is installed in `buildMcpServer` before `registerFsTools` is called. `registerFsTools` calls `reg.registerTool(...)` (which resolves to the patched method), so the guard fires for all 17 tools. Verified: `read_only` and `out_of_allowlist` error codes present in built `main.js`.

---

### Response-shape changes (DONE_WITH_CONCERNS flags)

The 17 tool **schemas** intentionally changed to the best-of-both registry (approved per brief). Four tools additionally have **response** shape changes:

**1. `obsidian_resolve` — schema + response both changed (approved)**
- Old schema: `{ ref: string, from?: string }` → Old response: `{ ref, resolved: path | null }`
- New schema: `{ refs: string[], from?: string }` → New response: `{ resolved: [...ResolveResult], ambiguous: [...], unresolved: [...] }`
- Impact: Existing callers using `ref` (singular) will get a schema validation error. This was explicitly approved as the "best-of-both schema". The `from` param is accepted by the schema but NOT forwarded to `ObsidianBackend.resolve()` (same graceful degradation as for the FS backend; documented in register-fs-tools.ts).

**2. `obsidian_get_backlinks` — field rename**
- Old: `{ path, backlink_count: N, backlinks: [...] }`
- New: `{ path, count: N, backlinks: [...] }` (`backlink_count` → `count`)
- Impact: Callers reading `backlink_count` will get `undefined`; `count` is present.

**3. `obsidian_force_reindex` — response shape changed**
- Old: `{ status: "live", message: "metadata cache is live; no reindex needed" }`
- New (via registerFsTools without includeIndexStatus): `{ status: "ready", prev_count: 0, count: 0, duration_ms: N }` (status "ready" not "live"; `message` field gone; timing fields added)
- Why: `registerFsTools` builds a timing response for force_reindex using `includeIndexStatus()` if provided. Passing a function would add `index_status` to all read tool responses (unwanted). Omitting it yields the "ready" fallback response. This is the least-bad tradeoff; passing the option would change 9 read-tool responses instead of 1.

**4. `obsidian_move_note` — response shape changed**
- Old: `{ from, to, moved: true }`
- New: `{ from, to, backlinks_updated: 0, backlinks_files_touched: 0 }` (`moved` field gone; backlink counts added as zeros)
- Why: `VaultBackend.moveNote` requires returning `{ from, to, backlinks_updated, backlinks_files_touched }`. Obsidian's `renameFile` always rewrites backlinks but doesn't expose a count, so zeros are returned. The `moved: true` field is superseded by the presence of `from`/`to` in a success response.

---

### Step 4 live check (human acceptance gate)

The human should confirm after loading the built `main.js` in Obsidian:

1. `vault-mcp` lists **38 base tools** (plus conditional integration tools if Dataview/Templater/Omnisearch/Metadata Menu are loaded).
2. `obsidian_read_note` with a valid path returns `{ path, content }` with the note's content.
3. `obsidian_manage_frontmatter` with op=set on a temp note, then op=get, round-trips the value.
4. `obsidian_resolve` now requires `refs` (plural array), not `ref` — verify the new schema is advertised.
5. `obsidian_get_backlinks` returns `count` (not `backlink_count`).
6. Read-only mode and allowlist still block the expected tools (guardCall still fires).
