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

---

## Fix — correctness findings from Task 7 review (commit `ce4234a`)

**Status:** DONE — all 4 findings + cleanup addressed.

**Build:** all three packages clean — `npm run build --workspace packages/core|server|plugin` emitted zero errors; plugin emits `main.js` 402.2 KB.

**Tests:** `npm test --workspaces --if-present` — all green.
- `@vault-mcp/core`: 59 pass, 0 fail
- `obsidian-vault-mcp-plugin`: 64 pass, 0 fail
- `obsidian-vault-mcp-server`: 12 pass, 0 fail (12 tests — 9 pre-existing + 3 new)

---

### Fix 1 — `move_note` backlinks_updated:0 → omit unknown counts (CRITICAL)

**Changed files:** `vault-backend.ts`, `obsidian-backend.ts`, `register-fs-tools.ts`, test.

- `VaultBackend.moveNote` return type: `backlinks_updated: number | null`, `backlinks_files_touched: number | null`. Null means "operation succeeded but count is unknowable", not "zero".
- `ObsidianBackend.moveNote` now returns `null` for both (Obsidian's `renameFile` rewrites backlinks internally with no count API).
- `FilesystemBackend.moveNote` unchanged — continues returning real integer counts.
- `register-fs-tools.ts` `obsidian_move_note` handler: omits `backlinks_updated`/`backlinks_files_touched` from the response when they are `null`, rather than emitting `0`.

**Truthful shapes:**
- Live plugin (ObsidianBackend): `{ from, to }` — no count fields (truthful: rewrites happened, count unknown)
- FS server (FilesystemBackend): `{ from, to, backlinks_updated: N, backlinks_files_touched: M }` — unchanged

**Test evidence:**
- `obsidian_move_note with numeric counts includes them in response (FS backend path)`: asserts `backlinks_updated === 3` and `backlinks_files_touched === 2` are present
- `obsidian_move_note with null counts omits them from response (live Obsidian backend path)`: asserts neither field is present when backend returns null

---

### Fix 2 — `force_reindex` count:0 fallback → truthful live-cache shape (IMPORTANT)

**Changed file:** `register-fs-tools.ts`.

- When `includeIndexStatus` is absent (plugin path), handler now returns `{ status: "live", duration_ms }` — still calls `backend.forceReindex()` and times it, but emits a shape that says "cache is always live, no index to rebuild" instead of the misleading `{status:"ready", prev_count:0, count:0, ...}`.
- When `includeIndexStatus` is provided (FS server path), the handler is unchanged — real rebuild with before/after counts.

**Test evidence:**
- `obsidian_force_reindex without includeIndexStatus returns live-cache shape`: asserts `status === "live"`, `duration_ms` present, `prev_count`/`count` absent
- Existing `obsidian_force_reindex returns timing fields and calls backend.forceReindex()` (uses statusFn) still passes, proving the FS path is intact

---

### Fix 3 — `resolve` `from` restored (IMPORTANT)

**Changed files:** `vault-backend.ts`, `obsidian-backend.ts`, `filesystem-backend.ts`, `register-fs-tools.ts`, `tool-registry.ts`.

- `VaultBackend.resolve` signature: added `from?: string` parameter.
- `ObsidianBackend.resolve`: passes `from ?? ""` to `getFirstLinkpathDest(clean, from ?? "")` for each ref. Context-sensitive disambiguation now works when the caller provides `from`.
- `FilesystemBackend.resolve`: accepts `_from?: string` for interface parity; ignores it (FS index resolver doesn't yet do folder-relative disambiguation).
- `register-fs-tools.ts`: the handler now passes `decodedFrom` (decoded `from`) to `backend.resolve`.
- `tool-registry.ts` `obsidian_resolve.from` description: updated to state it is honored by the live Obsidian backend (passes to `getFirstLinkpathDest`) and ignored (best-effort) by the FS backend.

**Verification:** `grep getFirstLinkpathDest obsidian-backend.ts` → line 177 shows `getFirstLinkpathDest(clean, from ?? "")` — no hardcoded `""`.

---

### Fix 4 — `update_backlinks:false` silently ignored on live backend — documentation (IMPORTANT)

**Changed file:** `tool-registry.ts`.

- `obsidian_move_note` `update_backlinks` field description now reads: "Advisory on the live Obsidian backend: `renameFile` always rewrites backlinks regardless of this value (Obsidian has no rename-without-rewrite API). Fully honoured by the filesystem backend."

---

### Fix 5 — Remove dead `export { CHARACTER_LIMIT }` from `obsidian-backend.ts` (MINOR)

**Changed file:** `obsidian-backend.ts`.

- Removed the `export { CHARACTER_LIMIT }` re-export and its comment at the bottom of the file. The local `const CHARACTER_LIMIT = 100_000` is still used internally by `readNote`. No imports pointed to `obsidian-backend.ts` for this constant; `register-fs-tools.ts` correctly imports it from `./fs-backend/vault.js`.

---

## Auto-review fixes (commit `43692db`)

**Status:** DONE — all 5 findings addressed.

**Build:** all three packages clean — `npm run build --workspace packages/{core,server,plugin}` emitted zero errors; plugin emits `main.js` 402.4 KB.

**Tests:** `npm test --workspaces --if-present` — all green.
- `@vault-mcp/core`: 59 pass, 0 fail
- `obsidian-vault-mcp-plugin`: 64 pass, 0 fail
- `obsidian-vault-mcp-server`: 16 pass, 0 fail (up from 12: 4 new tests added)

---

### FIX 1 — `obsidian_resolve` alias/matched_by divergence

**Changed file:** `obsidian-backend.ts`.

- `ObsidianBackend.resolve` now extracts the `|display alias` from the ref before stripping it, and sets `alias` on the `ResolveResult`.
- `matched_by` is determined by comparing `clean` against `dest.path` (→ `"path"`), the note's `jd-id` frontmatter field (→ `"jd-id"`), `dest.basename` case-insensitively (→ `"basename"`), or falling back to `"alias"`.
- Matches the exact discriminant vocabulary used by `index-store._resolveRefs`.

**Test evidence:** `obsidian_resolve: alias and matched_by from backend are preserved in resolved response` — uses an `AliasingBackend` that returns `alias: "Display Alias"` and `matched_by: "basename"`, verifies both are present in the `resolved` array.

---

### FIX 2 — `readNote` fabricated `truncated` + missing context guard

**Changed file:** `obsidian-backend.ts`.

- `ObsidianBackend.readNote` now truncates at `CHARACTER_LIMIT` (slices to limit, appends `\n\n[truncated: note is N chars, showing first 100000]` trailer) — identical behavior to `VaultImpl.readNote` in vault.ts.
- Imported `CHARACTER_LIMIT` from `@vault-mcp/core`; removed local duplicate `const CHARACTER_LIMIT = 100_000`.
- After the fix, `content.length > CHARACTER_LIMIT` in the `obsidian_read_notes` handler is truthful: it fires only when the content actually was truncated (trailer makes len > limit).

**Test evidence:** `obsidian_read_notes: truncated:true is accurate — content is capped at CHARACTER_LIMIT with trailer` — uses a `TruncatingBackend` (subclass applying the same truncation logic), writes a note > CHARACTER_LIMIT, verifies `truncated: true`, content length <= CHARACTER_LIMIT + trailer overhead, and `[truncated:` marker present.

---

### FIX 3 — `obsidian_force_reindex` read-only-mode regression

**Changed files:** `tool-registry.ts`, `registry-reconciliation.md`, `core/tests/tool-registry.test.mjs`.

- `obsidian_force_reindex` annotation changed from `{readOnlyHint:false,...}` back to `RO` (`{readOnlyHint:true, destructiveHint:false, idempotentHint:true, openWorldHint:false}`). Reindex reads the vault and rebuilds the in-memory index; it never mutates vault data, so `readOnlyHint:false` was wrong.
- Comment updated to state the rationale clearly.
- `registry-reconciliation.md` updated to reflect `readOnlyHint:true` with corrected rationale.

**Test evidence:** `obsidian_force_reindex is read-only (rebuilds in-memory index, never mutates vault data)` — asserts `readOnlyHint === true` (was `false`).

---

### FIX 4 — `obsidian_move_note` lost success flag

**Changed file:** `register-fs-tools.ts`.

- `obsidian_move_note` success response now includes `moved: true`, symmetric with `delete_note` (`deleted: true`) and `write_note` (`created: boolean`).
- Null-count omission is preserved (no fabricated backlink counts for the live backend).

**Test evidence:** `obsidian_move_note response includes moved:true` — verifies `data.moved === true`.

---

### FIX 5 — remove dead `readNotes` interface method

**Changed files:** `vault-backend.ts`, `filesystem-backend.ts`, `obsidian-backend.ts`, `server/src/index.ts`, `register-fs-tools.test.ts`.

- `VaultBackend.readNotes` removed from the interface.
- Implementations deleted from `FilesystemBackend`, `ObsidianBackend`, and server `makeBackend`.
- `ReadNotesResult` import removed from `filesystem-backend.ts` and `register-fs-tools.test.ts` (was only used in the now-deleted method).
- `FakeVaultBackend.readNotes` removed from the test fixture.
- Grep confirms zero remaining `.readNotes(` call sites.

**Test evidence:** `VaultBackend interface has no readNotes method — FakeVaultBackend must not implement it` — runtime check that `"readNotes" in backend` is false.
