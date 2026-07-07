{ config, pkgs, lib, ... }:

# The two services that ARE the system, shared across every render target
# (cloud VM and proxmox-lxc). Machine-specifics live in nix/hosts/*.

let
  user = "vault";
  vaultDir = "/var/lib/obsidian/vault";
  mcpPort = 8787;
  vault-mcp = pkgs.callPackage ../pkgs/vault-mcp.nix { };

  # obsidian-headless is installed at service start via npm — see obsidian-sync
  # below. The upstream repo (obsidianmd/obsidian-headless) ships a pnpm-lock,
  # not package-lock.json, which `buildNpmPackage` can't consume; the documented
  # fallback (pinned global install) is the path that works today.
  # Reproducible-in-practice via the version pin; not fully pure.
  obsidianHeadlessVersion = "0.0.10";
  obsidianHeadlessRoot = "/var/lib/obsidian/obsidian-headless";

  # Sandbox baseline shared by both services (systemd-analyze security scored
  # vault-mcp 8.3 EXPOSED / obsidian-sync 9.2 UNSAFE before this). Both are
  # Node processes that only need: their state dir, loopback/outbound sockets,
  # and ordinary syscalls. MemoryDenyWriteExecute is deliberately ABSENT —
  # V8's JIT needs writable+executable pages and the service crashes with it.
  # AF_UNIX stays allowed: glibc's nss-resolve talks to systemd-resolved over
  # a unix socket, so dropping it silently breaks DNS for obsidian-sync.
  serviceHardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectKernelLogs = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    # ProtectProc hides other users' processes; ProcSubset="pid" is NOT set —
    # it would hide /proc/cpuinfo (npm worker-count detection) and
    # /proc/sys/fs/inotify/* (chokidar's watch-limit check). Both degrade
    # gracefully but needlessly.
    ProtectProc = "invisible";
    RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
    RestrictNamespaces = true;
    RestrictRealtime = true;
    RestrictSUIDSGID = true;
    LockPersonality = true;
    CapabilityBoundingSet = "";
    SystemCallFilter = [ "@system-service" ];
    SystemCallArchitectures = "native";
    UMask = "0077";
    RemoveIPC = true;
  };
in
{
  options.vaultMcp = {
    authEnabled = lib.mkEnableOption "OAuth resource-server enforcement (Phase 2)";
    resourceUrl = lib.mkOption { type = lib.types.str; default = ""; };
    issuer = lib.mkOption { type = lib.types.str; default = ""; };
    jwksUri = lib.mkOption { type = lib.types.str; default = ""; };
  };

  config = {
    users.users.${user} = {
      isSystemUser = true;
      group = user;
      home = "/var/lib/obsidian";
      createHome = true;
    };
    users.groups.${user} = { };

    # --- obsidian-headless: continuous Sync into the shared vault folder ---
    systemd.services.obsidian-sync = {
      description = "Obsidian headless continuous sync";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.nodejs_22 ];
      # First start: npm-install the pinned obsidian-headless under StateDirectory.
      # Subsequent starts: skip install if the bin is already there. Pure-in-practice
      # via the version pin; fetches from the public npm registry on cold start.
      script = ''
        if [ ! -x ${obsidianHeadlessRoot}/node_modules/.bin/ob ]; then
          ${pkgs.nodejs_22}/bin/npm install \
            --prefix ${obsidianHeadlessRoot} \
            --no-fund --no-audit \
            obsidian-headless@${obsidianHeadlessVersion}
        fi
        exec ${obsidianHeadlessRoot}/node_modules/.bin/ob sync --continuous
      '';
      serviceConfig = {
        Type = "simple";
        User = user;
        Group = user;
        # systemd creates and chowns each listed dir to `vault` at start time
        # (StateDirectory chowns to User= for static users since systemd 235+).
        # The `obsidian/vault` entry is what closes the chicken-and-egg from
        # the first deploy: WorkingDirectory below points at /var/lib/obsidian/vault,
        # but that dir is only populated by `ob sync-setup` (a 🛑 HUMAN bootstrap).
        # Before this fix, fresh installs failed `status=200/CHDIR` until the
        # human ran sync-setup. With the vault dir pre-created, the service
        # gets past CHDIR — it still fails with "no sync configuration" until
        # the bootstrap, but that's a recoverable state, not a startup error.
        StateDirectory = "obsidian obsidian/vault obsidian/obsidian-headless";
        WorkingDirectory = vaultDir;
        Restart = "on-failure";
        RestartSec = "10";
        # ProtectSystem=strict in the baseline makes the FS read-only except
        # the StateDirectory tree above — npm's cache lands in $HOME/.npm
        # which is /var/lib/obsidian/.npm, inside StateDirectory "obsidian".
      } // serviceHardening;
      # NOTE: `ob login` is interactive (email/pw/MFA) and must be run ONCE by a
      # human to populate the credential dir under /var/lib/obsidian before this
      # service can sync. See HANDOFF.md, the 🛑 HUMAN checkpoint.
    };

    # --- the MCP server, reading/writing the same vault folder ---
    systemd.services.vault-mcp = {
      description = "Obsidian vault MCP server (Streamable HTTP, localhost)";
      after = [ "obsidian-sync.service" ];
      wants = [ "obsidian-sync.service" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        VAULT_PATH = vaultDir;
        PORT = toString mcpPort;
        HOST = "127.0.0.1"; # Caddy fronts it; never bind public directly
        AUTH_ENABLED = lib.boolToString config.vaultMcp.authEnabled;
        MCP_RESOURCE_URL = config.vaultMcp.resourceUrl;
        AUTH_ISSUER = config.vaultMcp.issuer;
        AUTH_JWKS_URI = config.vaultMcp.jwksUri;
        AUTH_SCOPES = "vault.read vault.write";
      };
      serviceConfig = {
        Type = "simple";
        User = user;
        Group = user;
        ExecStart = "${vault-mcp}/bin/vault-mcp";
        Restart = "on-failure";
        # The service only needs its vault state dir writable.
        ReadWritePaths = [ "/var/lib/obsidian" ];
      } // serviceHardening
      # Phase 1 (auth off): the MCP never initiates or accepts non-loopback
      # traffic — Caddy connects over 127.0.0.1 and there are no outbound
      # calls. Pin it to loopback at the cgroup level. Phase 2 lifts this:
      # token validation fetches the AS's JWKS over HTTPS.
      // lib.optionalAttrs (!config.vaultMcp.authEnabled) {
        IPAddressAllow = [ "localhost" ];
        IPAddressDeny = "any";
      };
    };
  };
}
