# Remote plugin-backed mode (`obsidian.nelson.love` → macbook-pro)

This hosts `obsidian.nelson.love` on the macbook-pro instead of the (retired)
Vultr VPS, and — unlike the filesystem server in `index.ts` — routes every MCP
call **through the running Obsidian app** via the `vault-mcp` plugin, so reads
and writes are canonical and sync-safe.

```
Claude Code / API  ──Authorization: Bearer <token>──►  https://obsidian.nelson.love/mcp
     │
Cloudflare edge   TLS (proxied CNAME → tunnel); token is the auth gate
     │  tunnel (outbound; no inbound ports on the mac)
cloudflared (LaunchAgent)  ──►  http://127.0.0.1:8787
     │
remote-proxy.ts (LaunchAgent)  ── spawns ──►  node ~/.claude/vault-mcp/bridge.mjs
     │                                              │ unix socket
     └─ Bearer-token gate + idle session reaper     └─ vault-mcp plugin in Obsidian → Obsidian APIs
```

**Requires** Obsidian running on the mac with the `vault-mcp` plugin enabled
(the proxy talks to its `~/.claude/vault-mcp/<vault>.sock`). If the mac sleeps
or Obsidian is closed, the endpoint is down.

## 1. Token + env

```bash
mkdir -p ~/.config/vault-mcp-remote ~/.local/state/vault-mcp-remote
umask 077
cat > ~/.config/vault-mcp-remote/env <<EOF
VAULT_MCP_TOKEN=$(openssl rand -hex 32)
PORT=8787
HOST=127.0.0.1
EOF
chmod 600 ~/.config/vault-mcp-remote/env
```

The token is the primary auth. Keep it out of git; this file (chmod 600) or
Doppler are the right homes. Print it when you need to configure a client:
`grep VAULT_MCP_TOKEN ~/.config/vault-mcp-remote/env`.

## 2. Proxy service

```bash
npm install && npm run build        # emits dist/remote-proxy.js
cp deploy/com.nelson.vault-mcp-remote.plist.template \
   ~/Library/LaunchAgents/com.nelson.vault-mcp-remote.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nelson.vault-mcp-remote.plist
curl -s localhost:8787/health        # {"status":"ok"}
```

## 3. Cloudflare tunnel (remotely-managed, token-based)

The live setup uses a **remotely-managed** tunnel: the tunnel and its ingress
rule live at Cloudflare, and `cloudflared` runs locally with just a token — no
`cloudflared tunnel login`, no local `config.yml`, no `sudo service install`.
Create it via the Cloudflare API/dashboard (the `nelson.love` zone is on
Cloudflare):

1. **Create tunnel** `obsidian-vault` with `config_src: "cloudflare"`
   (`POST /accounts/<acct>/cfd_tunnel`), then fetch its **run token**
   (`GET …/cfd_tunnel/<id>/token`).
2. **Set ingress** (`PUT …/cfd_tunnel/<id>/configurations`):
   `obsidian.nelson.love → http://127.0.0.1:8787`, catch-all `http_status:404`.
3. **DNS:** point `obsidian.nelson.love` at a **proxied CNAME → `<id>.cfargotunnel.com`**
   (replaces the old `A → 64.176.217.235`).
4. **Store the token** and start the connector:
   ```bash
   umask 077
   printf '%s' '<RUN-TOKEN>' > ~/.config/vault-mcp-remote/tunnel-token
   chmod 600 ~/.config/vault-mcp-remote/tunnel-token
   cp deploy/com.nelson.cloudflared-obsidian.plist.template \
      ~/Library/LaunchAgents/com.nelson.cloudflared-obsidian.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nelson.cloudflared-obsidian.plist
   grep -i 'Registered tunnel connection' ~/.local/state/vault-mcp-remote/cloudflared.log
   ```

> **Ingress port must match** the proxy's `PORT` (`~/.config/vault-mcp-remote/env`,
> default `8787`). It's set in the Cloudflare tunnel config (step 2), not a local
> file — update it there if you change `PORT`.
>
> ⚠️ **Little Snitch / per-app outbound filters.** Add a **permanent allow rule
> for `/opt/homebrew/bin/cloudflared`.** Headless under launchd there's no GUI to
> approve an alert, so an un-ruled connection is silently dropped: the tunnel never
> registers, the TCP connects but the TLS/QUIC handshake times out (looks like an
> MTU/network fault but isn't). Same applies to any new binary that dials the edge.
>
> **Transient DNS note.** If cloudflared connect/reconnect is suddenly slow (tens
> of seconds of `i/o timeout` on the Tailscale IPv6 resolver `fd7a:115c:a1e0::53`),
> that's a transient Tailscale MagicDNS blip, not a config problem — it recovers on
> its own. No `TUNNEL_EDGE`/`--protocol`/`NO_PRECHECKS` workarounds are needed in
> steady state (default config connects in ~6s over QUIC).

## 4. Connect a client

```bash
claude mcp add --transport http obsidian-remote https://obsidian.nelson.love/mcp \
  --header "Authorization: Bearer $(grep -oE '[0-9a-f]{64}' ~/.config/vault-mcp-remote/env)"
```

Claude Code and the Claude API send the static Bearer token. The claude.ai
**web app** can't send a static token (OAuth-only) — use the OAuth path below.

## 5. claude.ai web (OAuth via Clerk) — as actually deployed

The proxy is **dual-auth**: static token *or* a Clerk OAuth token, plus a
**per-user allowlist**. It serves the RFC 9728 PRM at
`/.well-known/oauth-protected-resource` so claude.ai discovers the AS. `src/auth.ts`
is the resource-server half. Two Clerk realities shaped the final wiring:

- **Clerk issues *opaque* access tokens** (`oat_…`) by default — the per-app
  "Generate access tokens as JWTs" toggle wasn't available in this dashboard and
  the API field is undiscovered. So the proxy validates tokens by **RFC 7662
  introspection** (`AUTH_INTROSPECTION_URL`), *not* JWKS. (If you do flip the app
  to JWTs, the JWKS path in `auth.ts` also works — set `MCP_RESOURCE_URL` to the
  token's real `aud`.)
- **DCR isn't enabled**, so claude.ai uses a **pre-registered** OAuth client
  (client_id + secret pasted into the connector's Advanced settings).

1. **Clerk** → Dashboard → [**OAuth applications**](https://dashboard.clerk.com/~/oauth-applications)
   → create an app (confidential). Redirect URIs:
   `https://claude.ai/api/mcp/auth_callback` **and** `https://claude.com/api/mcp/auth_callback`.
   Note the **client_id**, **client_secret**, and the instance **issuer**
   (dev `https://<slug>.clerk.accounts.dev`, prod `https://clerk.<domain>.com`).
   (CLI equivalent: `clerk apps create …`, `clerk api oauth_applications -X POST …`.)
   > **Lock it to you:** set the instance to restricted sign-up and/or rely on the
   > allowlist below — the introspection path accepts any active token *for this
   > client*, so the allowlist is the real "single user" gate.
2. **Server env** — add to `~/.config/vault-mcp-remote/env` (chmod 600), then
   restart the proxy LaunchAgent:
   ```
   AUTH_ENABLED=true
   MCP_RESOURCE_URL=https://obsidian.nelson.love/mcp        # PRM resource id
   AUTH_ISSUER=<Clerk issuer>                               # e.g. https://fit-foal-42.clerk.accounts.dev
   AUTH_JWKS_URI=<Clerk issuer>/.well-known/jwks.json       # required to boot; only exercised if app issues JWTs
   AUTH_SERVERS=<Clerk issuer>                              # advertised in PRM
   AUTH_SCOPES="openid profile email"                       # match Clerk's supported scopes
   AUTH_INTROSPECTION_URL=<Clerk issuer>/oauth/token_info   # RFC 7662 (opaque tokens)
   AUTH_CLIENT_ID=<client_id>                               # introspection auth + client binding
   AUTH_CLIENT_SECRET=<client_secret>
   AUTH_ALLOWED_SUBS=user_xxxxxxxx                          # the ONLY authorized Clerk user id(s)
   ```
   Keep `VAULT_MCP_TOKEN` set too, so Claude Code/API still use the static token.
   The proxy **refuses to start** with `AUTH_ENABLED=true` and no
   `AUTH_ALLOWED_SUBS`/`AUTH_ALLOWED_EMAILS` (fail-closed — else any AS sign-up
   would reach the vault); set `AUTH_ALLOW_ANY_AUTHENTICATED=true` only to
   intentionally allow every authenticated user. Get your user id from
   `clerk api users`, or the `introspect-debug` log line under `VAULT_MCP_DEBUG_AUTH`.
3. **claude.ai** → Settings → Connectors → add `https://obsidian.nelson.love/mcp`,
   paste **client_id + client_secret** in **Advanced settings**, save, and complete
   the Clerk login. Only the allowlisted user id gets in (everyone else → 403).
   The authenticated connector syncs to iOS.

## Config reference (`remote-proxy.ts`)

| Env | Default | Meaning |
| --- | --- | --- |
| `VAULT_MCP_TOKEN` | *(static auth)* | static Bearer token (Claude Code/API); required unless `AUTH_ENABLED=true` |
| `AUTH_ENABLED` | `false` | enable the OAuth path (JWT + introspection) + PRM discovery |
| `MCP_RESOURCE_URL` | — | PRM `resource` id; also the required JWT `aud` (JWT path only) |
| `AUTH_ISSUER` / `AUTH_JWKS_URI` / `AUTH_SERVERS` / `AUTH_SCOPES` | — | AS wiring (JWKS path + PRM advertising) |
| `AUTH_INTROSPECTION_URL` | — | RFC 7662 endpoint for **opaque** tokens (Clerk's `oat_`); uses `AUTH_CLIENT_ID`/`SECRET` |
| `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` | — | OAuth client creds — introspection auth **and** the client-binding check |
| `AUTH_ALLOWED_SUBS` / `AUTH_ALLOWED_EMAILS` | — | authorized `sub`s / **verified** emails; **required** when `AUTH_ENABLED` (fail-closed) |
| `AUTH_ALLOW_ANY_AUTHENTICATED` | `false` | opt out of the allowlist requirement (allow every authenticated user) |
| `AUTH_SKIP_AUD_CHECK` | `false` | JWT-path bootstrap: skip `aud` binding (leave OFF in production) |
| `VAULT_MCP_DEBUG_AUTH` | `false` | verbose auth diagnostics to stderr (no token/PII); OFF by default |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | local listen (tunnel target); keep on loopback |
| `VAULT_MCP_BRIDGE` | `~/.claude/vault-mcp/bridge.mjs` | plugin stdio bridge to spawn per session |
| `VAULT_MCP_IDLE_MS` / `VAULT_MCP_MAX_SESSIONS` | `1800000` / `32` | session idle-reap window; concurrent-backend cap |

> Startup is **fail-closed**: the proxy refuses to run with no auth at all, and
> with `AUTH_ENABLED=true` but no allowlist (unless `AUTH_ALLOW_ANY_AUTHENTICATED`).
