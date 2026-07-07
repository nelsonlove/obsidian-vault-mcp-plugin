# secrets/ — agenix-encrypted secrets

These files are **encrypted** (age) and safe to commit. Plaintext never lives
here or in the Nix store. You must create them before the targets that consume
them will build.

## Required before deploy

| File | Consumed by | Needed for |
| --- | --- | --- |
| `tailscale-authkey.age` | `nix/hosts/lxc.nix` | Proxmox LXC admin plane (Tailscale). The cloud VM does NOT need this. |
| `oauth-*.age` (Phase 2) | host file wiring the AS | OAuth, when you reach Phase 4 |

## Create a secret

1. Write `secrets.nix` listing who may decrypt (your key + each host key):
   ```nix
   let
     me   = "ssh-ed25519 AAAA...your-personal-key...";
     host = "ssh-ed25519 AAAA...host-key-after-first-boot...";
   in {
     "tailscale-authkey.age".publicKeys = [ me host ];
   }
   ```
2. Encrypt the value (generate the key in the Tailscale admin console first):
   ```bash
   nix run github:ryantm/agenix -- -e secrets/tailscale-authkey.age
   ```
3. Commit the resulting `.age` ciphertext.

## Note on build order

`nix build .#proxmox-lxc` (and `nixosConfigurations.cloud` if you add secrets to
it) will **fail to evaluate** if a referenced `.age` file is missing — this is
expected, not a bug. Create the secret first. The cloud VM target builds without
any secret, since `tailscale-authkey` is declared only in `lxc.nix`.
