{ config, modulesPath, lib, ... }:
# Proxmox LXC render target. nixos-generators' proxmox-lxc format supplies the
# container plumbing; we just add the bits the NixOS wiki calls for and the
# admin-access choice for the home box.
{
  # The Tailscale auth key, encrypted with agenix. Declared HERE (not in the
  # shared host.nix) so the cloud VM — which has no tailnet — doesn't require
  # this .age file to build. Create it before first deploy with:
  #   nix run github:ryantm/agenix -- -e secrets/tailscale-authkey.age
  age.secrets.tailscale-authkey.file = ../../secrets/tailscale-authkey.age;

  # On the home Proxmox box, the admin plane uses Tailscale instead of public
  # SSH (the cloud host can't rely on a permanent tailnet, but the real box can).
  # authKeyFile lets the container join the tailnet non-interactively on first
  # boot; without it, tailscaled comes up unauthenticated and you'd have to run
  # `tailscale up` by hand.
  services.tailscale = {
    enable = true;
    authKeyFile = config.age.secrets.tailscale-authkey.path;
  };

  # LXC specifics per the NixOS wiki (nesting must be enabled on the CT in
  # Proxmox; networking via DHCP by default).
  networking.useDHCP = lib.mkDefault true;

  # SSH reachable over the tailnet on the home box.
  networking.firewall.trustedInterfaces = [ "tailscale0" ];

  system.stateVersion = "24.11";
}
