# NIXOS.md — How this repo is structured (the "repo it" answer)

The decision: **NixOS-as-the-unit.** The flake is the single source of truth for
the whole machine. From it we render **two formats** of the *same* system:

- a **cloud KVM VM** for today's host (cloud providers sell KVM VMs, not LXC
  guests — you cannot boot an LXC template on Hetzner/Vultr), deployed with
  `nixos-anywhere`;
- a **Proxmox LXC template** for the real box later, built with
  `nixos-generators -f proxmox-lxc`.

Crucially, the format differs but the *config* does not. The two services and
all host hardening live in shared modules; only disk/boot/admin-access differ
per target. So "reproduce it" = "read the flake," and migrating cloud→Proxmox is
re-rendering, not rebuilding. No Docker anywhere; the two processes run as native
systemd services.

## Layout

```
flake.nix                     # inputs + the two render targets
nix/
├── modules/
│   ├── services.nix          # SHARED: obsidian-sync + vault-mcp systemd services
│   └── host.nix              # SHARED: Caddy(TLS), firewall, SSH, connector plane
├── pkgs/
│   ├── vault-mcp.nix         # buildNpmPackage for THIS server (src = repo root)
│   └── obsidian-headless.nix # buildNpmPackage for the Sync client
└── hosts/
    ├── cloud.nix             # cloud VM: bootloader, public SSH key
    ├── cloud-disk.nix        # disko layout (nixos-anywhere only)
    └── lxc.nix               # Proxmox LXC: Tailscale admin, nesting/DHCP notes
src/                          # the TypeScript MCP server (unchanged, tested)
```

The TypeScript server in `src/` is identical to the Docker-era build — only its
*packaging* changed (Dockerfile → `nix/pkgs/vault-mcp.nix`). The OAuth
resource-server layer (`src/auth.ts`) is unchanged and still tested.

## Build / deploy

**Today (cloud VM via nixos-anywhere):**
```bash
# set your SSH key in nix/hosts/cloud.nix and domain in nix/modules/host.nix first
nix run github:nix-community/nixos-anywhere -- --flake .#cloud root@<VPS_IP>
```

**Real box (Proxmox LXC template):**
```bash
nix build .#proxmox-lxc          # → ./result, a .tar.xz CT template
# upload result to Proxmox CT Templates, create the container with Nesting ON,
# ostype unmanaged. (See HANDOFF Phase 5 for the pct create incantation.)
```

**Just the server package (for local testing):**
```bash
nix build .#vault-mcp && ./result/bin/vault-mcp   # honors VAULT_PATH/PORT/HOST
```

## The two hashes you must fill in once

Nix can't be handed a precomputed dependency hash from outside, so two fields
are `lib.fakeHash` placeholders. The standard dance for each:

1. run the build (`nix build .#vault-mcp`, then `.#proxmox-lxc`);
2. it fails and prints `got: sha256-…`;
3. paste that into the corresponding field and rebuild.

The fields:
- `nix/pkgs/vault-mcp.nix` → `npmDepsHash`
- `nix/pkgs/obsidian-headless.nix` → `src` hash **and** `npmDepsHash` (also
  confirm the upstream `owner/repo/rev` — set against the real obsidian-headless
  source at build time).

This is normal NixOS workflow, not a defect. A visible `fakeHash` is honest; a
guessed hash would be worse.

## Known rough edge: packaging obsidian-headless

`vault-mcp` packages cleanly (it's our own code + lockfile). `obsidian-headless`
is third-party and its pure source build may need tweaking. If
`nix/pkgs/obsidian-headless.nix` fights you, use the documented **fallback** in
that file: a pinned `npm install -g obsidian-headless@<ver>` at service start
into a `StateDirectory`. Reproducible-in-practice via the pin, not fully pure —
an acceptable trade for one stubborn dependency, and easy to revisit later.

## Security model recap (why no Tailscale on the cloud box)

- **Connector plane (public):** Claude reaches the MCP endpoint from Anthropic's
  cloud, so it must be public HTTPS. Caddy + OAuth (Phase 2) guard it. In Phase 1
  the firewall also drops non-Anthropic traffic to 443 as a stopgap.
- **Admin plane:** on the **cloud VM**, admin is public SSH (keys only) — there's
  no permanent tailnet to lean on. On the **Proxmox box**, `lxc.nix` enables
  Tailscale so admin/SSH rides the tailnet and needn't be public at all. This is
  the one deliberate per-target difference beyond disk/boot.
## Operational details (secrets, ACME, break-glass, backups)

These are the practical bits that aren't obvious from the module files. Folded
in from the original runbook, which has been retired.

### Secrets via agenix — never inline

The Nix store is **world-readable**, so no secret (Tailscale auth key, OAuth
client secret) may be written literally into a `.nix` file. Use agenix: encrypt
with your age/SSH key, commit only the ciphertext, decrypt at activation into
`/run/secrets`.

```bash
# create/edit an encrypted secret
nix run github:ryantm/agenix -- -e secrets/tailscale-authkey.age
```

`secrets/secrets.nix` lists who may decrypt — your personal key plus the host
key (fill the host key in after first boot, then re-key and commit):

```nix
let
  me   = "ssh-ed25519 AAAA...your-personal-key...";
  host = "ssh-ed25519 AAAA...server-host-key...";   # add after first boot
in { "tailscale-authkey.age".publicKeys = [ me host ]; }
```

Reference it in config where the secret is consumed. The Tailscale auth key is
declared and used in `nix/hosts/lxc.nix` (not shared `host.nix`, so the cloud VM
needn't ship a tailnet key):
`services.tailscale.authKeyFile = config.age.secrets.tailscale-authkey.path;`
The Phase 2 OAuth secrets get declared the same way, in whichever host file
wires the authorization server.

### ACME / firewall interaction (the gotcha)

Caddy fetches Let's Encrypt certs over **port 80**, so 80 must stay reachable
from the internet — don't lock it to Anthropic's range. Only lock **443** in the
Phase 1 stopgap (`extraInputRules` in `host.nix`, nftables syntax). If ACME
still struggles behind the IP rule, switch Caddy to the **DNS challenge**
instead, after which you can drop public 80 entirely.

### The one-time `ob login` is sensitive state

The Obsidian credential/token from `ob login` lives under the service's
`StateDirectory` (`/var/lib/obsidian`) and persists across rebuilds and reboots.
Treat that directory as a secret. If you rebuild the *machine* from scratch
(fresh `nixos-anywhere` or a new LXC from the template), you redo the one login —
note it in your own ops notes.

### Break-glass access

On the Proxmox box, admin rides Tailscale and public SSH is closed — so if
Tailscale ever fails, get in via the **provider's serial/console** (Proxmox: the
CT console; a cloud VM: the provider's web console). Record that console login
somewhere out-of-band; it's your only way back in if the tailnet is down.

### Backups

Obsidian Sync replicates the vault but is **not a backup** — it mirrors
deletions, so a bad delete propagates. For point-in-time recovery, run a
periodic `restic` or `borg` snapshot of `/var/lib/obsidian/vault` to object
storage. Independent of Sync, and cheap for a text vault.

### First-boot checklist (cloud VM)

After `nixos-anywhere` brings the box up:
1. Grab the host key; add it to `secrets/secrets.nix`; re-key agenix; commit.
2. SSH in; do the one-time `ob login` (HANDOFF Phase 2).
3. Confirm `systemctl status caddy obsidian-sync vault-mcp`.
