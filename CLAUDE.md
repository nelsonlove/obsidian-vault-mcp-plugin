# CLAUDE.md — Obsidian Vault MCP for Claude

> Auto-loaded by Claude Code as project context. States the goal, the locked
> decisions, the open ones, and the things an agent CANNOT do unattended. Read
> `NIXOS.md` for the flake structure and `HANDOFF.md` for the ordered build.

## Goal

Host an Obsidian vault on a server and expose it to Claude as a **remote custom
connector** that works on **desktop and iOS**. Read, search, write notes.
**Single-user** system (one person, one connector).

## Architecture (LOCKED)

- **NixOS-as-the-unit.** The flake is the single source of truth for the whole
  machine. NO Docker. The two processes run as native systemd services.
- **One flake → two render targets** (same shared modules, different machine
  layer):
  - **Cloud KVM VM** = today's host. Cloud providers sell KVM VMs, NOT LXC
    guests, so the cloud target is a VM deployed via `nixos-anywhere`.
  - **Proxmox LXC template** = the real box later, via `nixos-generators -f
    proxmox-lxc`. The user's real box runs Proxmox.
- **Two services, sharing one vault folder:**
  - `obsidian-sync` — official `obsidian-headless` Sync client; keeps the vault
    folder current. ~35MB. NOT the desktop app / Electron / Xvfb.
  - `vault-mcp` — the MCP server (this repo, `src/`). Reads/writes the vault.
    Stateless Streamable HTTP transport.
- **Transport: Streamable HTTP** (stdio can't be a remote connector; SSE is
  deprecated).
- **Security: public HTTPS + OAuth.** Claude connects from Anthropic's cloud
  (egress `160.79.104.0/21`), not the user's device, so the endpoint MUST be
  public. OAuth (Phase 2) is load-bearing — see `vault-mcp-oauth-phase2.md`. The
  MCP server is an OAuth 2.1 **resource server** (validates tokens, doesn't
  issue them); `src/auth.ts` implements that half and is tested.
- **Admin plane differs per target:** cloud VM = public SSH (keys only); Proxmox
  LXC = Tailscale (the home box can rely on a tailnet, the cloud box can't).

## Update (2026-07): plugin-backed remote mode on the macbook-pro

The NixOS/VPS deployment above is retired (the Vultr box is down). `obsidian.nelson.love`
is now hosted on the **macbook-pro** via `src/remote-proxy.ts` (`npm run start:proxy`),
which fronts the in-Obsidian [`vault-mcp`](https://github.com/nelsonlove/obsidian-vault-mcp-plugin)
plugin over Streamable HTTP instead of the filesystem server. Edits go **through
Obsidian** (sync-safe). See `deploy/REMOTE.md`. This **diverges from the LOCKED
"Security: public HTTPS + OAuth" decision above** in one respect:

- **Auth is dual + per-user allowlist — LIVE & working** (`remote-proxy.ts`,
  PRs #34/#36). Static Bearer `VAULT_MCP_TOKEN` for **Claude Code / API**, OR
  **Clerk OAuth** for **claude.ai web**; PRM discovery served. Two Clerk realities:
  it issues **opaque `oat_` tokens** (not JWTs — dashboard toggle unavailable), so
  the proxy validates them by **RFC 7662 introspection** (`AUTH_INTROSPECTION_URL`
  + `AUTH_CLIENT_ID`/`SECRET`, which also client-binds the token), not JWKS; and
  **DCR isn't enabled**, so claude.ai uses a **pre-registered** client (id/secret in
  the connector's Advanced settings). Authorization is a **per-user allowlist**
  (`AUTH_ALLOWED_SUBS`; verified-email fallback) and startup is **fail-closed**
  (refuses to run with OAuth on and no allowlist unless `AUTH_ALLOW_ANY_AUTHENTICATED`).
  The JWKS/JWT path in `auth.ts` still works if the app is ever switched to JWTs.
  See `deploy/REMOTE.md` § 5 for the exact env.
- **Reachability:** the endpoint is up only while the mac is awake and Obsidian is
  running with the plugin enabled (Cloudflare Tunnel, no inbound ports).

## Decisions still OPEN (ask, don't assume)

- **Today's cloud host:** recommended Hetzner CX22 (~$4.59/mo) or Oracle Always
  Free ($0, more friction). Confirm before provisioning.
- **Authorization server (Phase 2):** **decided & shipped — Clerk** (pre-registered
  client + opaque-token introspection + per-user allowlist). See `deploy/REMOTE.md` § 5.

## What an agent CANNOT do (hard boundaries — flag and hand back)

- **`ob login`** — interactive Obsidian auth (email/pw/MFA). Human runs once.
- **The two `lib.fakeHash` fills** require running `nix build` and reading the
  printed hash — agent CAN do this iteratively, but it needs a machine with Nix.
- **Provisioning/paying for the VPS**, DNS records, account signups.
- **Generating secrets** (OAuth client secret, Tailscale key) — human creates at
  provider; agent wires via agenix, never inlines or commits plaintext.
- **Adding the connector in claude.ai** — browser, by the human; can't be added
  from iOS (syncs there after web).
- Any irreversible/paid action — confirm first.

## Verification affordances

- `GET /health` → `{status:"ok", vault, authEnabled}`
- MCP `tools/list` → 17 tools (list/list_folders/read/read_notes/search/find_by_tag/resolve/get_backlinks/get_outlinks/search_by_frontmatter/manage_frontmatter/patch_note/delete_note/move_note/write/append/force_reindex). Read tools carry `index_status` (including `last_built_at`) to distinguish cold-vault from empty-vault. Search supports `mode: "one_per_note" | "all"`. Index auto-refreshes on filesystem mutations via a chokidar watcher (per-path 250ms debounce, ~300ms total to fresh state via incremental per-file updates); `obsidian_force_reindex` is still available for callers that need a synchronous rebuild.
- `systemctl status obsidian-sync vault-mcp`; `journalctl -u …`
- auth on: no token → 401 + WWW-Authenticate; valid resource-bound token → 200

## Build/test status (verified vs not)

- **TypeScript build + 6 tools over HTTP:** tested, passing.
- **Path-traversal guard, .obsidian ignore, tag search:** tested.
- **OAuth resource-server (`src/auth.ts`):** tested vs local JWKS — valid→200,
  missing/wrong-aud/garbage→401. Confident.
- **Nix flake/derivations: NOT built** (no Nix in authoring env). Structurally
  written against verified nixos-generators/buildNpmPackage patterns, brace-
  checked only. Treat first `nix build` as a real checkpoint:
  - fill `npmDepsHash` in `nix/pkgs/vault-mcp.nix` (fakeHash dance);
  - fill `src` hash + `npmDepsHash` and confirm upstream coords in
    `nix/pkgs/obsidian-headless.nix` — most likely to need iteration; the
    fallback (pinned global install) is documented in that file and NIXOS.md.

## Repo map

- `flake.nix` — inputs + render targets
- `nix/modules/services.nix` — shared: the two systemd services
- `nix/modules/host.nix` — shared: Caddy/firewall/SSH/connector plane
- `nix/pkgs/{vault-mcp,obsidian-headless}.nix` — the two derivations
- `nix/hosts/{cloud,cloud-disk,lxc}.nix` — per-target machine layer
- `secrets/` — agenix-encrypted secrets (ciphertext, safe to commit) +
  `secrets/README.md`. `tailscale-authkey.age` must be created before the
  proxmox-lxc target will build; the cloud VM needs no secret.
- `src/{index,vault,auth}.ts` — the MCP server (unchanged, tested)
- `NIXOS.md` — flake structure + build/deploy + the hash dance, plus
  operational details (agenix secrets, ACME/firewall, break-glass, backups,
  first-boot checklist) folded in from the retired runbook
- `vault-mcp-oauth-phase2.md` — OAuth design + AS options

> Note: an earlier Docker Compose approach was explored and dropped in favor of
> NixOS-as-the-unit (cloud providers don't run LXC; the real box is Proxmox).
> No Docker artifacts remain — the reasoning is in the Architecture section above.
