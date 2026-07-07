{
  description = "Obsidian vault MCP server — NixOS, one flake, two render targets (cloud VM today, proxmox-lxc on the real box)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    nixos-generators = {
      url = "github:nix-community/nixos-generators";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    agenix = {
      url = "github:ryantm/agenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-generators, disko, agenix, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # The SHARED system definition: the two services + host hardening.
      # Machine-specific bits (disk, bootloader vs lxc) are layered on per target.
      commonModules = [
        ./nix/modules/services.nix
        ./nix/modules/host.nix
        agenix.nixosModules.default
      ];
    in
    {
      # Expose the MCP server package on its own (handy for `nix build .#vault-mcp`).
      # obsidian-headless used to be exposed here too, but the upstream repo ships
      # pnpm-lock (not package-lock), so `buildNpmPackage` can't consume it.
      # The service installs it via npm at first run instead — see services.nix.
      packages.${system} = {
        vault-mcp = pkgs.callPackage ./nix/pkgs/vault-mcp.nix { };

        # RENDER TARGET 1 (real box): a Proxmox LXC template (.tar.xz) you upload
        # to CT Templates and boot. Build with:
        #   nix build .#proxmox-lxc
        proxmox-lxc = nixos-generators.nixosGenerate {
          inherit system;
          format = "proxmox-lxc";
          modules = commonModules ++ [ ./nix/hosts/lxc.nix ];
          specialArgs = { inherit self; };
        };

        # Optional convenience: a qcow2 VM image, if you'd rather import a disk
        # image than run nixos-anywhere. Build with: nix build .#vm-qcow
        vm-qcow = nixos-generators.nixosGenerate {
          inherit system;
          format = "qcow";
          modules = commonModules ++ [ ./nix/hosts/cloud.nix ];
          specialArgs = { inherit self; };
        };
      };

      # RENDER TARGET 2 (today's host): a full NixOS system deployed to a cloud
      # KVM VPS via nixos-anywhere. Same shared modules, plus disk + bootloader.
      #   nix run github:nix-community/nixos-anywhere -- --flake .#cloud root@<IP>
      nixosConfigurations.cloud = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = commonModules ++ [
          disko.nixosModules.disko
          ./nix/hosts/cloud.nix
          ./nix/hosts/cloud-disk.nix
        ];
        specialArgs = { inherit self; };
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_22 pkgs.nixos-generators ];
      };
    };
}
