# CLAUDE.md — obsidian-vault-mcp-server

> Auto-loaded by Claude Code as project context. Describes the current (Phase 2a)
> monorepo server package — NOT the retired NixOS/VPS architecture.

## What this package is

The **presence-aware HTTP front** for the vault-mcp remote endpoint, hosted on
the macbook-pro behind a cloudflared tunnel (`obsidian.nelson.love`).

It is a single Express process (`src/front.ts`) that:

- Routes `/mcp` to the **LIVE proxy** (plugin-backed, 44 tools) when Obsidian's
  plugin Unix socket (`~/.claude/vault-mcp/<slug>.sock`) is reachable.
- Falls back to the **FS handler** (`@vault-mcp/core`'s `FilesystemBackend`,
  17 tools) when the socket is gone — no outage, graceful degradation.
- Returns to LIVE mode automatically when the plugin reconnects.

**FS-mode write caveat:** writes while Obsidian is closed are direct disk edits.
Obsidian Sync reconciles them on relaunch; they are canonical after that point.

## Auth (dual + per-user allowlist)

`src/auth.ts`'s `createAuthGate` accepts either:
- Static Bearer `VAULT_MCP_TOKEN` (Claude Code / API).
- Clerk OAuth opaque token (`oat_…`) validated via RFC 7662 introspection
  (`AUTH_INTROSPECTION_URL`) with client-binding (`AUTH_CLIENT_ID`/`SECRET`).

Startup is **fail-closed**: refuses to run without at least one auth method,
and with `AUTH_ENABLED=true` + no `AUTH_ALLOWED_SUBS`/`AUTH_ALLOWED_EMAILS`
(unless `AUTH_ALLOW_ANY_AUTHENTICATED=true`).

See `deploy/REMOTE.md` § 5 for the full env-var reference.

## Key modules

| File | Role |
| --- | --- |
| `src/front.ts` | Entrypoint + `buildFront` factory + `wireFailover` |
| `src/presence.ts` | `createPresenceMonitor` — socket-probe poll |
| `src/live-proxy.ts` | `createLiveProxy` — session factory (bridge.mjs per session) |
| `src/fs-mode.ts` | `createFsHandler` — stateless FS-mode request handler |
| `src/auth.ts` | `createAuthGate` + PRM / RFC 9728 helpers |

## Deployment

LaunchAgent runs `node dist/front.js`. Tunnel: cloudflared remotely-managed
(no local config.yml). Full setup: `deploy/REMOTE.md`.

## Build / test

```bash
npm run build --workspace packages/server   # tsc → dist/
npm test --workspace packages/server        # tsc + node --test dist/__tests__/*.test.js
```
