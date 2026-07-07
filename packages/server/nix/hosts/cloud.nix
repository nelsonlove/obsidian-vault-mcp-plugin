{ lib, modulesPath, ... }:
# Cloud KVM VPS render target (today's host). Boot + base; disk is in
# cloud-disk.nix (only used by the nixos-anywhere nixosConfiguration, not the
# qcow generator).
{
  imports = [
    # Pulls in the kernel modules a typical KVM guest needs in initrd
    # (virtio_blk, virtio_pci, virtio_net, virtio_scsi, etc). Without this,
    # initrd boots but can't see /dev/vda, so root mount fails with:
    #   "Can't lookup blockdev /dev/disk/by-partlabel/disk-main-root"
    # A raw nixosConfiguration has no auto-generated hardware-configuration.nix
    # to provide these, so we import the qemu-guest profile explicitly.
    "${modulesPath}/profiles/qemu-guest.nix"
  ];

  # Legacy BIOS boot (Vultr Cloud Compute boots BIOS on this image, not UEFI).
  # GRUB installs the MBR boot code on the whole disk and embeds core.img into
  # the GPT BIOS-boot partition declared in cloud-disk.nix.
  #
  # The install device is derived automatically by disko from the EF02 partition
  # in cloud-disk.nix — do NOT set `boot.loader.grub.device` here. Setting both
  # adds the same disk twice to `boot.loader.grub.mirroredBoots`, which trips
  # the "You cannot have duplicated devices in mirroredBoots" assertion at
  # evaluation time.
  boot.loader.grub.enable = lib.mkDefault true;

  # Public SSH on the cloud box (no permanent tailnet here). Keys only — set
  # your key below.
  networking.firewall.allowedTCPPorts = [ 22 ];
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILXHbH6xriFbjHuXMWDa8M8QTzZfnMZ+hHVTuKyw3LBT nelson@wham.studio"
  ];

  system.stateVersion = "24.11";
}
