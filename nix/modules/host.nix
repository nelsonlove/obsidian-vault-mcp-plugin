{ config, pkgs, lib, ... }:

# Host hardening shared across render targets. The CONNECTOR plane (public
# HTTPS → localhost MCP) is here. SSH/admin specifics that differ between a
# cloud VM and a home LXC are kept minimal and overridable per host.

let
  domain = "obsidian.nelson.love";
  mcpPort = 8787;
  anthropicEgress = "160.79.104.0/21"; # Claude's outbound range
in
{
  # ---- secrets (agenix): never inline; Nix store is world-readable ----
  # Secrets are declared in the host file that CONSUMES them, not here, so a
  # target that doesn't need a given secret (e.g. the cloud VM has no Tailscale
  # auth key) doesn't fail for a missing .age file. See:
  #   - nix/hosts/lxc.nix      → tailscale-authkey
  #   - Phase 2 (oauth) secrets → wherever the AS integration lives
  # Workflow: nix run github:ryantm/agenix -- -e secrets/<name>.age
  # (NIXOS.md "Operational details → Secrets via agenix" has the full pattern.)

  # ---- CONNECTOR PLANE: Caddy terminates TLS, proxies to localhost MCP ----
  services.caddy = {
    enable = true;
    virtualHosts.${domain}.extraConfig = ''
      reverse_proxy 127.0.0.1:${toString mcpPort}
    '';
  };

  # ---- SSH: keys only ----
  # Note: "no" here would block root SSH entirely, even with an authorized key,
  # and there's no non-root user declared — we'd be locked out. "prohibit-password"
  # (a.k.a. the old "without-password") allows key-based root logins and refuses
  # password attempts, which is the intent.
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  # ---- firewall ----
  # Use the nftables backend. `extraInputRules` is nftables syntax, and without
  # this it's silently a no-op (NixOS's default is iptables, which doesn't
  # understand `ip saddr != ... tcp dport ... drop`).
  networking.nftables.enable = true;
  networking.firewall = {
    enable = true;
    # ACME HTTP-01 only here. 443 is gated entirely in `extraInputRules` below
    # because if we listed 443 in `allowedTCPPorts`, NixOS's nftables emitter
    # would `accept` it BEFORE `extraInputRules` runs — and nftables stops at
    # the first matching verdict, so the saddr-based drop would be unreachable.
    allowedTCPPorts = [ 80 ];
    # PHASE 1 (authless) lock: only Anthropic's egress may hit the MCP. The
    # explicit drop after the accept is for readability — the input chain has
    # an implicit default-deny anyway. REMOVE both rules once OAuth (Phase 2)
    # is live; the browser login leg comes from the user's device, not
    # Anthropic's range. See vault-mcp-oauth-phase2.md.
    extraInputRules = ''
      ip saddr ${anthropicEgress} tcp dport 443 accept
      tcp dport 443 drop
    '';
  };

  environment.systemPackages = with pkgs; [ nodejs_22 git curl ];
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
}
