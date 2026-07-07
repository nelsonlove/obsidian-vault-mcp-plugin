# HANDOFF.md — Ordered Build Plan (NixOS-as-the-unit)

For Claude Code (or a human). Read `CLAUDE.md` then `NIXOS.md` first. Each phase
has a **verify** step — don't proceed past a failed one. **🛑 HUMAN** marks steps
only the user can do: prepare around them, then stop and ask.

Two-phase by necessity: a **cloud VM** runs the system now; the **Proxmox box**
adopts the *same flake* (rendered as an LXC template) later. The flake is the
artifact; migration is re-rendering, not rebuilding.

---

## Phase 0 — Local sanity (no server)

1. `npm ci && npm run build`; confirm `dist/index.js`. Smoke-test against a
   throwaway vault (see README) — health ok, `tools/list` returns 6 tools.
2. On a machine with Nix: `nix build .#vault-mcp`.
   **Verify / EXPECTED ITERATION:** first run fails with a `got: sha256-…` for
   `npmDepsHash` — paste it into `nix/pkgs/vault-mcp.nix`, rebuild until
   `./result/bin/vault-mcp` exists and runs. This is the normal fakeHash dance,
   not an error to debug away.

---

## Phase 1 — Provision today's cloud host

3. **🛑 HUMAN:** create the VPS (Hetzner CX22 ~$4.59/mo recommended, or Oracle
   Always Free). Point a DNS A record (e.g. `vault-mcp.<domain>`) at it. Hand
   back IP + hostname. Confirm host choice before spending.
4. Edit before deploy: SSH key in `nix/hosts/cloud.nix`, domain in
   `nix/modules/host.nix`, disk device in `nix/hosts/cloud-disk.nix` if not
   `/dev/sda`.
5. Deploy: `nix run github:nix-community/nixos-anywhere -- --flake .#cloud root@<IP>`.
   **Verify:** box reboots into NixOS; `ssh` in; `systemctl status` shows
   `caddy`, `obsidian-sync` (failing until login — expected), `vault-mcp`.

---

## Phase 2 — One-time Obsidian login (🛑 HUMAN)

6. `obsidian-sync` can't sync until credentials exist. As the `vault` user:
   ```
   ob login                      # 🛑 email / password / MFA
   ob sync-list-remote           # confirm the vault appears
   ob sync-setup --vault "Your Vault Name"
   ```
   Then `systemctl restart obsidian-sync`.
   **Verify:** `journalctl -u obsidian-sync` shows a completed sync;
   `/var/lib/obsidian/vault` is populated; `curl localhost:8787/health` ok.

---

## Phase 3 — Public TLS + connect to Claude (authless first, to prove the pipe)

7. Caddy (from `host.nix`) already terminates TLS for the domain.
   **Verify:** `https://vault-mcp.<domain>/health` works over real TLS.
   (Phase-1 firewall limits 443 to Anthropic's range — expected; test from the
   box itself or temporarily loosen.)
8. **🛑 HUMAN:** claude.ai desktop → Settings → Connectors → add custom
   connector → `https://vault-mcp.<domain>/mcp`, no auth.
   **Verify:** 6 tools appear; open iOS Claude and confirm the connector synced
   (can't add from iOS, only use). Cross-platform requirement proven.

---

## Phase 4 — OAuth (make it secure)

Follow `vault-mcp-oauth-phase2.md`.
9. **🛑 HUMAN + agent:** pick/stand up the authorization server (managed:
   WorkOS/Stytch; or self-hosted Ory Hydra). Configure **JWT** access tokens
   (not opaque). Pre-register ONE client (no DCR needed), redirect
   `https://claude.ai/api/mcp/auth_callback`.
10. Set `vaultMcp.authEnabled = true` and the `resourceUrl`/`issuer`/`jwksUri`
    options (in a host file or via agenix-sourced values); `nixos-rebuild
    switch --flake .#cloud --target-host …`.
11. **Verify (tested code, just confirm wiring):** PRM doc at
    `/.well-known/oauth-protected-resource`; no token → 401 + WWW-Authenticate;
    valid resource-bound token → 200.
12. Loosen the step-7 IP rule (in `host.nix`) so the browser login leg isn't
    blocked. **🛑 HUMAN:** re-authorize the connector in claude.ai; confirm
    desktop + iOS post-auth.

---

## Phase 5 — Migrate to the Proxmox box

13. Build the LXC template from the SAME flake:
    `nix build .#proxmox-lxc` → `./result` (a `.tar.xz`).
    **Prerequisite:** the LXC target references `secrets/tailscale-authkey.age`
    (the tailnet admin plane). Create it FIRST or the build fails to evaluate —
    this is expected, not a bug. See `secrets/README.md`:
    `nix run github:ryantm/agenix -- -e secrets/tailscale-authkey.age`
    (The cloud VM in Phase 1 needs no secret, which is why this only appears here.)
14. **🛑 HUMAN:** upload `result` to Proxmox CT Templates. Create the container
    via CLI (UI is known not to work for NixOS templates):
    ```
    pct create "$(pvesh get /cluster/nextid)" \
      local:vztmpl/<the-template>.tar.xz \
      --ostype unmanaged --features nesting=1 --unprivileged 1 \
      --net0 name=eth0,bridge=vmbr0,ip=dhcp --hostname vault-mcp --start 1
    ```
    Then ensure `lxc.init.cmd: /sbin/init` is set in the CT config.
15. Re-do the one-time `ob login` inside the container (or restore the
    credential dir). Repoint DNS to the box. The Tailscale admin plane
    (`lxc.nix`) means SSH need not be public.
    **Verify:** same health + `tools/list` + auth checks against the box.
    Decommission the cloud VM.

---

## Standing notes

- **Conflict edge:** only `vault-mcp` and the phone editing the *same note*
  within seconds races; Sync makes a conflict file, not data loss.
- **Backups:** snapshot the vault dir; Sync mirrors deletions, so it's not a
  backup.
- **Pins:** `obsidian-headless` version pinned in its derivation; bump
  deliberately. `nix flake update` bumps nixpkgs.
- **Two fakeHash fills** (`vault-mcp.nix`, `obsidian-headless.nix`) are the
  expected first-build iteration; see NIXOS.md.
- **If obsidian-headless won't build purely:** use the documented fallback
  (pinned global install) in `nix/pkgs/obsidian-headless.nix`.
