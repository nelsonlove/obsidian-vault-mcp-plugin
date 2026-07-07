## Task 7 Report: front.ts sole entrypoint; retire split proxy/fs servers

**Status:** DONE

**Commits:** `df7adf2`..`2d49236`

**Build:** `npm run build --workspace packages/server` → clean (tsc, zero errors); dist/ contains `front.js` only — no `index.js` or `remote-proxy.js` (stale compiled artefacts were also cleaned with `rm -rf dist/`).

**Tests (full workspaces):** `npm test --workspaces --if-present` → all green, exits cleanly.
- `@vault-mcp/core`: 59 pass, 0 fail
- `obsidian-vault-mcp-plugin`: 64 pass, 0 fail
- `obsidian-vault-mcp-server`: 43 pass, 0 fail
- **Total: 166 pass, 0 fail**

---

### What was deleted

- `packages/server/src/index.ts` — filesystem-only standalone server (superseded by `front.ts` FS-mode path)
- `packages/server/src/remote-proxy.ts` — plugin-proxy standalone server (superseded by `front.ts` LIVE-mode path)

### What was changed

**`packages/server/package.json`**
- `"main"` → `"dist/front.js"`
- `"start"` → `"node dist/front.js"`
- Removed `"start:proxy": "node dist/remote-proxy.js"`

**`packages/server/CLAUDE.md`**
- Replaced the stale NixOS/VPS/flake/systemd-era doc with an accurate monorepo-reality note (~40 lines). Covers: what the package is, failover behavior, auth summary, key modules table, deploy pointer, build/test commands.

**`packages/server/deploy/REMOTE.md`**
- Exists at `packages/server/deploy/REMOTE.md` (was already in the repo, not missing).
- Updated to describe the unified `front.ts` replacing the two processes.
- Documents: failover table (live → 44 tools; fs → 17 tools; no outage); `/health` `mode` + `fsWriteSyncCaveat` fields; new envs `VAULT_MCP_PRESENCE_POLL_MS` (default 5000) and `VAULT_MCP_SOCKET`; LaunchAgent runs `node dist/front.js`; full config reference updated (added presence/socket env rows, removed now-dead `start:proxy` mention).
- Auth/tunnel sections (§§ 2–5) preserved and accurate.

**`packages/server/src/auth.ts`**
- Renamed `[remote-proxy]` log prefixes (5 occurrences) to `[front]` to avoid confusing logs from a file that no longer exists.
- Removed `"(moved from remote-proxy.ts)"` from a section comment.

**`packages/server/src/front.ts`**
- Replaced `// Reap sessions idle longer than this. See remote-proxy.ts for rationale.` with a self-contained comment (no dangling reference to the deleted file).

---

### Remaining references to deleted files (non-import, cosmetic)

- `packages/server/README.md` — still references `remote-proxy.ts` and `npm run start:proxy` in the "Two modes" blurb at the top. Not updated in this task (not listed in the brief). The README describes the VPS-era architecture and is otherwise stale; a separate docs-cleanup task is the right venue.
- `packages/server/vault-mcp-oauth-phase2.md` — references `src/index.ts` at line 117 in a historical design-doc paragraph. Not a code reference; not updated.
- `packages/server/src/live-proxy.ts` — comment on line 4 says "Extracts … from remote-proxy.ts". Historical provenance note; not a dependency.

None of these are imports; all are documentation/comments. The build and grep both confirmed zero TypeScript import references to the deleted files.
