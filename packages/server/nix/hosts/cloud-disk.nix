{ ... }:
# disko layout for nixos-anywhere on a cloud VM. Adjust device for the provider:
# Vultr Cloud Compute (KVM/virtio) → /dev/vda; Hetzner → /dev/sda.
#
# This layout is for LEGACY BIOS boot on GPT (Vultr boots BIOS on this image,
# not UEFI). A 1MB BIOS-boot partition (type EF02) holds GRUB's core.img; /boot
# lives on the root filesystem — no separate ESP needed for legacy boot.
# If you re-provision on a UEFI host, swap `grub_bios` for an ESP at EF00 and
# flip the bootloader in cloud.nix back to systemd-boot.
{
  disko.devices.disk.main = {
    device = "/dev/vda";
    type = "disk";
    content = {
      type = "gpt";
      partitions = {
        grub_bios = { size = "1M"; type = "EF02"; };
        # 8G swap partition. disko runs `mkswap` + `swapon` during the install
        # phase, so the closure build has swap headroom (Vultr's 1.9 GiB RAM
        # otherwise OOM-kills nix-daemon during the rebuild). Also persists
        # post-reboot: disko generates the swapDevices entry automatically,
        # so future `nixos-rebuild switch` on the box has it too.
        swap = { size = "8G"; content = { type = "swap"; }; };
        root = { size = "100%";
          content = { type = "filesystem"; format = "ext4"; mountpoint = "/"; }; };
      };
    };
  };
}
