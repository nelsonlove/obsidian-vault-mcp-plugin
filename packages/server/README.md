# obsidian-vault-mcp-server

> Project hub: `93046 obsidian-vault-mcp-server` (Obsidian vault)

A minimal **remote** (Streamable HTTP) MCP server that exposes an Obsidian vault
*folder* to Claude for reading, searching, and writing markdown. It operates
directly on the files that `obsidian-headless` keeps synced — it does **not**
talk to the Obsidian app or any plugin REST API, so there's no Electron and no
Xvfb.

> **Two modes.** The default (`npm start`, `index.ts`) is the filesystem server
> above. There is also a **plugin-backed remote mode** (`npm run start:proxy`,
> `remote-proxy.ts`) that fronts the in-Obsidian [`vault-mcp`](https://github.com/nelsonlove/obsidian-vault-mcp-plugin)
> plugin over the same Streamable-HTTP interface, so edits go **through
> Obsidian** (canonical, sync-safe) instead of straight to disk. Use it when
> hosting on a machine where the interactive Obsidian app is running (e.g. the
> macbook-pro behind `obsidian.nelson.love`). Setup: [`deploy/REMOTE.md`](deploy/REMOTE.md).

## Tools

| Tool | Purpose | Mutates? |
| --- | --- | --- |
| `obsidian_list_notes` | List notes (optionally under a subfolder), paginated | no |
| `obsidian_list_folders` | List immediate child folders + recursive note count per folder | no |
| `obsidian_read_note` | Read a note by vault-relative path | no |
| `obsidian_read_notes` | Bulk read by paths (up to 50/call); failed paths land in `errors[]` instead of failing the call | no |
| `obsidian_search_notes` | Case-insensitive full-text search; `mode: "one_per_note" \| "all"` for hit breadth vs depth | no |
| `obsidian_find_by_tag` | Find notes by frontmatter `tags:` or inline `#tag` | no |
| `obsidian_resolve` | Obsidian-faithful reference resolution: `[[wikilink]]`, basename, frontmatter alias, JD-ID, or vault-relative path → canonical path. Handles `|alias`, `#heading`, `#^block`. Multiple matches → `ambiguous` with candidates | no |
| `obsidian_get_backlinks` | List notes that wikilink TO the given path | no |
| `obsidian_get_outlinks` | List `[[wikilinks]]` in the body of a note, each with resolved path when unambiguous | no |
| `obsidian_search_by_frontmatter` | Find notes whose frontmatter has `property == value` (case-insensitive property, exact value; array fields match any element) | no |
| `obsidian_manage_frontmatter` | Get / set / delete a single frontmatter field. Surgical line edits preserve other keys' formatting. Refuses block-scalar / inline-object shapes | yes (set/delete are destructive) |
| `obsidian_patch_note` | Anchor-based edit: insert/replace content relative to a heading section or `^block-id` paragraph. `previous` returned for undo/audit | yes (destructive) |
| `obsidian_delete_note` | Permanently delete a note. Requires `confirm: true` literal in the call schema | yes (destructive — propagates via Sync) |
| `obsidian_move_note` | Move / rename a note. By default rewrites `[[wikilinks]]` that resolved to `from` so they now point at `to`, preserving each ref's visual shape | yes (destructive — multi-file mutation) |
| `obsidian_write_note` | Create / overwrite a note | yes (destructive) |
| `obsidian_append_note` | Append to (or create) a note | yes |
| `obsidian_force_reindex` | Rebuild the in-memory index synchronously. The watcher auto-refreshes within ~1.5s; call this only for tight read-after-write loops or suspected missed events | no (cache only) |

All path-taking inputs (`path`, `paths`, `subdir`) are defensively
HTML-entity-decoded before resolution, so an agent passing `03 LLMs &amp; agents`
will hit the actual `03 LLMs & agents` folder. Covers `&amp; &lt; &gt; &quot; &apos;`
and numeric `&#NN;` / `&#xNN;` escapes.

## Run

```bash
npm install
npm run build
VAULT_PATH=/var/lib/obsidian/vault PORT=8787 HOST=127.0.0.1 npm start
```

Environment:

- `VAULT_PATH` — absolute path to the synced vault folder (default `./vault`)
- `PORT` — listen port (default `8787`)
- `HOST` — bind address (default `127.0.0.1`; keep it localhost behind your proxy)

The MCP endpoint is `POST /mcp`. There's also `GET /health`.

## Security model (read this)

This server has **no authentication of its own** — that's deliberate, matching
Phase 1 of the deployment plan (HANDOFF.md):

- Bind to `127.0.0.1` and put TLS + access control in your reverse proxy (Caddy).
- Firewall the public edge so only Anthropic's egress range `160.79.104.0/21`
  can reach it. That blocks internet scanners but does **not** identify *which*
  Claude user is connecting.
- For per-user identity, add a real OAuth layer (DCR/CIMD) in front of or inside
  this process (Phase 2). Claude does **not** support user-pasted static bearer
  tokens, so a shared secret header is not a substitute.

Path safety: all filesystem access goes through `resolveInVault`, which strips
leading `../` traversal so requests stay contained within `VAULT_PATH`, and
refuses paths that touch ignored folders (`.obsidian`, `.trash`, `.git`,
`node_modules`).

## Notes / limitations

- Search returns **one matching line per note** to keep results broad and the
  payload small; change the `break` in `searchNotes` for all-line matches.
- Tag extraction is lightweight (no YAML dependency). For robust frontmatter
  parsing, swap in `gray-matter`.
- Stateless transport: a fresh server+transport is built per POST, which avoids
  request-id collisions and scales trivially for single-user use.
- Large notes are truncated at `CHARACTER_LIMIT` (100k chars) on read.

## Deployment walkthrough (Vultr + UTM NixOS jump host)

This is the path that actually worked. `HANDOFF.md` has the canonical phased
plan; this is the practical sequence as deployed in the first end-to-end run.
For the reasoning behind specific decisions and a chronological log of fixes,
see the project journal in the vault: `93046.10 Requirements & design/Deployment journal`.

### Prerequisites

- **Cloud VPS** with KVM/virtio (Vultr Cloud Compute confirmed, others should work).
  Cheapest tier (~$3-6/mo) — anything ≥ 1 GiB RAM. BIOS or UEFI both OK; flake
  is currently configured for BIOS+GRUB (`nix/hosts/cloud-disk.nix`).
- **A domain** with DNS managed somewhere you can add A records. The flake
  currently hardcodes `obsidian.nelson.love` in `nix/modules/host.nix:8`.
- **A Linux machine with Nix** to run `nixos-anywhere` from. The Mac can be
  this directly (DeterminateSystems installer) or via a UTM NixOS VM. macOS
  binfmt-emulating x86 builds crash on Go binaries (Caddy) — use
  `--build-on-remote` always.

### 1. Provision the VPS

- Create a Vultr Cloud Compute instance, any OS image (it'll be wiped). Note the IP.
- **Attach the NixOS x86_64 minimal ISO** via Vultr panel → Settings → Custom ISO.
- Reboot. Boot from ISO. In Vultr's web console, run `passwd` to set a throwaway
  root password (the NixOS live ISO has no password by default and sshd refuses
  empty-password logins).

### 2. DNS

- A record: `<your-subdomain>` → `<vps-ip>`
- **Cloudflare:** set to **DNS only (gray cloud)**, not proxied. Caddy's HTTP-01
  ACME challenge needs to reach the origin directly on port 80. Orange cloud
  breaks the cert flow. (You can flip to orange later if you switch Caddy to
  DNS-01 challenge with a Cloudflare API token.)

### 3. Edit the flake for your deploy

Three placeholders before the first deploy:

- `nix/hosts/cloud.nix:13` — root SSH public key. **The key in the flake belongs
  to Nelson** — replace with yours.
- `nix/modules/host.nix:8` — `domain = "obsidian.nelson.love";` — replace with
  your subdomain.
- `nix/hosts/cloud-disk.nix:13` — `device = "/dev/vda";` — Vultr default. Hetzner
  uses `/dev/sda`. Confirm with `lsblk` if uncertain.

Commit + push.

### 4. Run nixos-anywhere

From your Linux Nix host (e.g., UTM VM), with a GitHub PAT in scope for fetching
the private flake:

```bash
NIX_CONFIG="access-tokens = github.com=ghp_YOUR_TOKEN" \
  nix run github:nix-community/nixos-anywhere -- \
    --flake github:<owner>/obsidian-vault-mcp-server/<commit>#cloud \
    --build-on-remote \
    root@<vps-ip>
```

**You will likely hit the swap OOM.** See the [Deployment caveats](#deployment-caveats-vultr-small-tier-kvm)
section below — when `nix-daemon disconnected unexpectedly` shows up, ssh to
the box, add an 8 GB swap file to `/mnt`, then resume with `--phases install,reboot`.

After `### Done! ###`:

- **Vultr panel → Settings → Custom ISO → detach the ISO** before the box reboots
  into the installed system. Otherwise it'll boot the ISO again and you'll be
  back at the start.
- Reboot from the Vultr panel.

### 5. Verify the install

From your Mac:

```bash
ssh-keygen -R <vps-ip>     # host key changed during install
ssh root@<vps-ip>          # should be key-based, no password
```

Inside:

```bash
systemctl status caddy vault-mcp obsidian-sync
# expected: caddy + vault-mcp active; obsidian-sync failing (pre-ob-login, fine)
curl -sS http://127.0.0.1:8787/health
# {"status":"ok","vault":"/var/lib/obsidian/vault","authEnabled":false}
```

DNS + Caddy ACME (port 80 from anywhere is open by default):

```bash
journalctl -u caddy | tail -30
# look for "certificate obtained successfully"
curl -sS https://<your-domain>/health     # from your Mac, BEFORE the firewall lock kicks in fully
```

Confirm the nftables firewall rule landed:

```bash
nft list ruleset | grep -A 2 'tcp dport 443'
# expect:
#   ip saddr 160.79.104.0/21 tcp dport 443 accept
#   tcp dport 443 drop
```

And from your Mac — `https://<your-domain>/mcp` should **now time out** (only
Anthropic egress can reach it). That confirms Phase 1 lockdown is in effect.

### 6. Bootstrap Obsidian Sync (`ob login` — interactive)

The `obsidian-sync` service is a chicken-and-egg case: it expects
`/var/lib/obsidian/vault` to exist but that dir is only created after first
`ob sync-setup`. Bootstrap manually:

```bash
systemctl stop obsidian-sync

sudo -u vault bash -i
cd /var/lib/obsidian/vault          # critical: be in this exact dir, not the parent
# pre-install the obsidian-headless package the service will use:
npm install --prefix /var/lib/obsidian/obsidian-headless \
  --no-fund --no-audit obsidian-headless@0.0.10
mkdir -p /var/lib/obsidian/vault

/var/lib/obsidian/obsidian-headless/node_modules/.bin/ob login            # email + pw + MFA + E2E password
/var/lib/obsidian/obsidian-headless/node_modules/.bin/ob sync-list-remote # confirm vault appears
# IMPORTANT: copy the EXACT vault name from sync-list-remote output
/var/lib/obsidian/obsidian-headless/node_modules/.bin/ob sync-setup --vault "<exact name>"

exit
systemctl start obsidian-sync
journalctl -u obsidian-sync -f
```

**Critical gotcha:** the cwd when you run `ob sync-setup` is the local root
that gets associated with the vault. If you run it from `/var/lib/obsidian`
(the vault user's HOME) instead of `/var/lib/obsidian/vault`, Sync will treat
everything under `/var/lib/obsidian` as part of the vault and push the
contents (including the npm-installed `obsidian-headless/` directory)
upstream to your Mac and iPhone. **Run from inside `/var/lib/obsidian/vault`.**

### 7. Add the connector in claude.ai

- claude.ai desktop browser → Settings → Connectors → Add custom connector
- URL: `https://<your-domain>/mcp`
- Auth: none (Phase 1)
- Save — all 17 tools appear in the per-tool permission list. Set each to
  Allow / Ask / Deny to taste.
- Open Claude on iOS — connector syncs automatically (you can't add from iOS,
  only use)

#### Lazy tool loading in claude.ai sessions

claude.ai uses **deferred tool loading** for connectors with broad surfaces:
the model doesn't materialize every tool into its working context at session
start. When you ask a fresh session *"what obsidian tools do you have?"* it
will run a tool search and return whatever subset the search ranks highest —
often 5–7, not all 17 — and report that as its complete inventory. This is
**not a server bug** and not a destructive-tool filter; the connector still
advertises all 17 in `tools/list`.

The model loads tool schemas on demand. To work around the partial
enumeration:

- Name a tool by ID (`"use obsidian_delete_note to..."`) — the client
  lazy-loads its schema and the model can call it.
- Ask the session broadly upfront (`"load every obsidian tool — read AND
  write"`) — that drives a wider tool search and pulls in the full set.
- Describe the capability ("how do I move a note?") — nudges the model
  toward the right tool name even when its top-K search missed it.

If a fresh session reports a partial list, that's the explanation; reach for
the prompts above, not a redeploy.

Done. Phase 4 (real OAuth) is documented in `vault-mcp-oauth-phase2.md`.

## Deployment caveats (Vultr small-tier KVM)

- **disko swap partition isn't activated at install time on the pinned disko
  rev** (`115e5211...`, set in `flake.lock`). The `swap = { content.type =
  "swap"; }` declaration in `nix/hosts/cloud-disk.nix` creates the partition
  but `swapon` doesn't run during the install phase. On a low-RAM Vultr tier
  (~1.9 GiB), `nixos-anywhere` will OOM-kill `nix-daemon` mid-`### Building
  the system closure ###` and bail with `Nix daemon disconnected unexpectedly`.
- **Workaround:** SSH to the box mid-install, add an 8 GB swap file to `/mnt`,
  then resume with `--phases install,reboot`:
  ```bash
  # on the box, after disko has mounted /mnt:
  dd if=/dev/zero of=/mnt/swapfile bs=1M count=8192 status=progress
  chmod 600 /mnt/swapfile && mkswap /mnt/swapfile && swapon /mnt/swapfile

  # then re-run nixos-anywhere with --phases install,reboot
  ```
- **Possible fix to investigate later:** the disko partition may need an
  explicit `priority` or `discardPolicy` option to trip the install-time
  `swapon`, or upgrading the disko input may resolve it. If you upgrade
  disko via `nix flake update`, drop this workaround.

## Wiring into the deployment

In the NixOS `vault-mcp` systemd service (`nix/modules/services.nix`), the
package's launcher is invoked directly and the env is set on the unit:

```nix
environment = {
  VAULT_PATH = "/var/lib/obsidian/vault";
  PORT = "8787";
  HOST = "127.0.0.1";
};
ExecStart = "${vault-mcp}/bin/vault-mcp";
```
