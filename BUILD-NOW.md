# BUILD-NOW.md — Revised next steps (server-side Nix)

> Supersedes the implicit "install Nix locally" assumption. For a single box
> deployed once, there is **no need for Nix on the user's Mac**. The one Nix
> evaluation happens **on the cloud VM itself**. The Mac only runs `ssh`.
>
> This sits alongside HANDOFF.md. HANDOFF describes the full phased plan;
> BUILD-NOW is the concrete near-term path to a *working* system, with the
> toolchain question resolved.

## Why server-side (the decision)

`nixos-anywhere` is the "clean" path (evaluate the flake on a workstation, push a
reproducible image to a blank target). But it pulls in a Linux remote builder on
macOS (the targets are Linux) for little benefit when there's **one box, built
rarely**. Building directly on the VM keeps the flake as source of truth, costs
nothing extra, and removes the local toolchain entirely.

Trade-off to accept knowingly: building *on* the live box is slightly less pure
than render-image-then-deploy. Fine for now. If the pure flow is wanted later
(or to test the **proxmox-lxc** template before the Proxmox box exists), that is
the point to introduce Nix on a controlled machine or CI — a Phase 5 concern,
not now.

## Order of operations

### 1. Provision the cloud VM  🛑 HUMAN
- Hetzner CX22 (~$4.59/mo) recommended, or Oracle Always Free.
- Install NixOS on it. Two ways:
  - provider has a NixOS image / ISO → use it; or
  - boot Debian/Ubuntu and convert (nixos-infect), or kexec into a NixOS
    installer. (Hetzner: mount the NixOS ISO on the running instance.)
- Point a DNS **A record** (e.g. `vault-mcp.<domain>`) at the VM's IP.
- Hand back IP + hostname.

### 2. Put the repo on the VM
```bash
scp -r obsidian-vault-mcp-server <user>@<vm>:~/   # or git clone on the box
ssh <user>@<vm>
cd obsidian-vault-mcp-server
```
Ensure flakes are enabled on the box:
```bash
mkdir -p ~/.config/nix && echo 'experimental-features = nix-command flakes' >> ~/.config/nix/nix.conf
```

### 3. ⭐ Build `obsidian-headless` FIRST (riskiest piece)
This is the one derivation with unverified upstream coordinates + a possible
source-build failure. Resolve it before wiring anything else.
```bash
nix build .#obsidian-headless
```
- **If it does the fakeHash dance** (fails → prints `got: sha256-…` → paste into
  `nix/pkgs/obsidian-headless.nix` → rebuild; there are TWO hashes here, `src`
  and `npmDepsHash`): good, continue.
- **If upstream `owner/repo/rev` is wrong, or it won't build from source:** stop
  and switch to the documented **fallback** in `nix/pkgs/obsidian-headless.nix`
  (pinned `npm install -g obsidian-headless@<ver>` into a StateDirectory).
  Reproducible-in-practice via the version pin. Know which path you're on before
  proceeding.

### 4. Build `vault-mcp` (low risk — our own code)
```bash
nix build .#vault-mcp        # fakeHash dance once for npmDepsHash
./result/bin/vault-mcp --help 2>/dev/null || true   # sanity: binary exists
```

### 5. Realize the whole system on the VM
Instead of `nixos-anywhere` from a workstation, build/switch in place. Set the
machine identity first:
- SSH key in `nix/hosts/cloud.nix`
- domain in `nix/modules/host.nix`
- disk device in `nix/hosts/cloud-disk.nix` if not `/dev/sda`

```bash
sudo nixos-rebuild switch --flake .#cloud
```
**Verify:** `systemctl status caddy obsidian-sync vault-mcp` — `caddy` and
`vault-mcp` up; `obsidian-sync` failing until login (expected, next step).

### 6. One-time Obsidian login  🛑 HUMAN
As the `vault` service user on the box:
```bash
ob login                       # email / password / MFA
ob sync-list-remote            # confirm the vault appears
ob sync-setup --vault "Your Vault Name"
sudo systemctl restart obsidian-sync
```
**Verify:** `journalctl -u obsidian-sync` shows a completed sync;
`/var/lib/obsidian/vault` populated; `curl localhost:8787/health` ok.

### 7. Public TLS + connect to Claude  🛑 HUMAN
- Caddy already serves TLS for the domain (`host.nix`). Confirm
  `https://vault-mcp.<domain>/health` over real TLS. (Phase-1 firewall limits 443
  to Anthropic's range — test from the box, or loosen briefly.)
- claude.ai **desktop** → Settings → Connectors → add custom connector →
  `https://vault-mcp.<domain>/mcp`, no auth.
- **Verify:** 6 tools appear; open Claude on **iOS** and confirm the connector
  synced (can't add from iOS, only use).

That is a **working** system. OAuth (Phase 4) is hardening — see below.

## Before Phase 4 (OAuth): one decision, upstream of any code
⭐ **Choose an authorization server that issues JWT access tokens, not opaque
ones.** `src/auth.ts` validates JWTs via JWKS; opaque tokens would require an
RFC 7662 introspection call instead (a code change, not a toggle).
- Self-hosted: **Ory Hydra in JWT-access-token mode**.
- Managed: WorkOS / Stytch (confirm JWT config).
- Keycloak / Zitadel default to JWT.
Then follow `vault-mcp-oauth-phase2.md`.

## What still needs a controlled Nix machine (later, not now)
- Building the **proxmox-lxc** template (`nix build .#proxmox-lxc`) to test
  before the Proxmox box exists — can't be meaningfully done on the cloud VM.
  Requires `secrets/tailscale-authkey.age` to exist first (see
  `secrets/README.md`); evaluation fails without it, which is expected.
- The pure "render image → deploy → never touch host" flow, if wanted.

## Status recap
- TypeScript half: verified (npm install + tsc pass).
- Nix half: structurally sound, **unbuilt**. The fakeHash dances in steps 3–4
  are the first real evaluation. `obsidian-headless` is the one with genuine
  build risk; `vault-mcp` is low risk.
- No local Nix required for any of the above.
