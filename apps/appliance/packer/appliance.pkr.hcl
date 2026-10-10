# Builds the Vigil appliance VM image: a bootable Debian 12 qcow2 with a
# checksum-verified Node.js runtime, the esbuild-bundled collector service,
# and a hardened systemd unit. cloud-init (NoCloud, cd_label "cidata")
# provisions the build boot only — the seed files live in packer/http/ and
# the credentials are generated fresh by apps/appliance/scripts/build.sh.
#
# PR CI runs validation only (packer fmt -check && packer validate): hosted
# runners cannot be assumed to expose /dev/kvm. The full build runs at
# release via scripts/build.sh, with accelerator autodetected kvm -> tcg.

packer {
  required_version = ">= 1.9.0"
  required_plugins {
    qemu = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/qemu"
    }
  }
}

# Base image pin. Checksum fetched 2026-10-10 from the official Debian cloud
# image sums (verify the qcow2 line you copy):
#
#   https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS
#
#   a09170d17e13af43da61774666f520e3bbec0f8bd96b4db37c15f3426fb327ccad950b80d
#   be78c09aa5ca90ce5015e99334b0ba5188fd4018736bc3fb5f0882c
#     debian-12-genericcloud-amd64.qcow2
#
# The "latest" directory is a moving symlink; the checksum below is the pin.
# To bump the base image, re-fetch the SUMS file and update both defaults.
variable "debian_qcow2_url" {
  type    = string
  default = "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
}

variable "debian_qcow2_sha512" {
  type    = string
  default = "a09170d17e13af43da61774666f520e3bbec0f8bd96b4db37c15f3426fb327ccad950b80dbe78c09aa5ca90ce5015e99334b0ba5188fd4018736bc3fb5f0882c"
}

# "kvm" when /dev/kvm is usable (fast), "tcg" everywhere else (software
# emulation; slow but works on hosted runners). scripts/build.sh autodetects.
variable "accelerator" {
  type    = string
  default = "tcg"
  validation {
    condition     = contains(["kvm", "tcg"], var.accelerator)
    error_message = "Accelerator must be \"kvm\" or \"tcg\"."
  }
}

# Release version of the image; names the produced qcow2. build.sh defaults
# it from apps/desktop/package.json and the release workflow passes it
# explicitly.
variable "version" {
  type    = string
  default = "0.0.0-dev"
}

variable "disk_size" {
  type    = string
  default = "32G"
}

# Throwaway builder credentials for the build boot. build.sh generates an
# ed25519 keypair per build and passes both halves; nothing is baked into
# the image (harden.sh removes the builder user and its authorized_keys).
variable "builder_ssh_pubkey" {
  type    = string
  default = ""
}

variable "builder_ssh_private_key_path" {
  type    = string
  default = ""
}

source "qemu" "appliance" {
  iso_url        = var.debian_qcow2_url
  iso_checksum   = "sha512:${var.debian_qcow2_sha512}"
  disk_image     = true
  format         = "qcow2"
  accelerator    = var.accelerator
  memory         = 2048
  cpus           = 2
  disk_size      = var.disk_size
  disk_interface = "virtio"
  net_device     = "virtio-net"

  output_directory = "${path.root}/output"
  vm_name          = "vigil-appliance-${var.version}.qcow2"
  headless         = true

  # Build-boot NoCloud seed: an ISO labeled "cidata" carrying meta-data and
  # the rendered user-data (builder user + per-build SSH key). Packer builds
  # this CD per run; it is not part of the output image.
  cd_files = ["${path.root}/http/meta-data"]
  cd_content = {
    "user-data" = templatefile("${path.root}/http/user-data.tftpl", {
      builder_ssh_pubkey = var.builder_ssh_pubkey
    })
  }
  cd_label = "cidata"

  communicator         = "ssh"
  ssh_username         = "builder"
  ssh_private_key_file = var.builder_ssh_private_key_path
  ssh_timeout          = "45m"
  shutdown_command     = "sudo shutdown -P now"
}

build {
  sources = ["source.qemu.appliance"]

  # The file provisioner uploads as the SSH user and requires destination
  # directories to already exist, so create /tmp/vigil-build first.
  provisioner "shell" {
    inline = ["mkdir -p /tmp/vigil-build"]
  }

  # Collector source, staged for the in-VM bundle (collector.sh). Test files
  # ride along harmlessly: esbuild only follows imports from service.ts.
  provisioner "file" {
    source      = "${path.root}/../collector/src"
    destination = "/tmp/vigil-build"
  }

  # Pinned build dependencies for the in-VM bundle; npm ci verifies them
  # against the committed lockfile's integrity hashes.
  provisioner "file" {
    source      = "${path.root}/provision/package.json"
    destination = "/tmp/vigil-build/package.json"
  }
  provisioner "file" {
    source      = "${path.root}/provision/package-lock.json"
    destination = "/tmp/vigil-build/package-lock.json"
  }

  provisioner "shell" {
    execute_command = "sudo -E bash {{ .Path }}"
    scripts = [
      "${path.root}/provision/node.sh",
      "${path.root}/provision/collector.sh",
      "${path.root}/provision/harden.sh",
    ]
  }
}
