#!/usr/bin/env bash
# Builds the Vigil appliance VM image with Packer (QEMU) and emits SHA256SUMS
# for the produced qcow2. The full build is a release-time job (PR CI runs
# packer validate only — hosted runners cannot be assumed to expose KVM).
#
# Usage: scripts/build.sh [version]
#   version defaults to apps/desktop/package.json's version; the release
#   workflow passes it explicitly. Credentials for the build boot are
#   generated fresh into a temp dir and deleted afterwards; they are never
#   committed and never baked into the image.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)
PACKER_DIR="$REPO_ROOT/apps/appliance/packer"

for cmd in packer qemu-system-x86_64 ssh-keygen node curl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "build.sh: missing dependency: $cmd" >&2
    exit 1
  fi
done

VERSION=${1:-$(node -p "require('$REPO_ROOT/apps/desktop/package.json').version")}
if [[ -z "$VERSION" ]]; then
  echo "build.sh: could not determine image version" >&2
  exit 1
fi

# Accelerator autodetect: KVM when /dev/kvm is present and usable, otherwise
# TCG software emulation (slow — expect tens of minutes).
accelerator=tcg
if [[ -e /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]; then
  accelerator=kvm
else
  {
    echo '******************************************************************'
    echo '* WARNING: /dev/kvm not available — building with TCG software    *'
    echo '* emulation. This can take tens of minutes. Install qemu-system-* *'
    echo '* with KVM access for a fast build.                               *'
    echo '******************************************************************'
  } >&2
fi
echo "build.sh: accelerator=$accelerator version=$VERSION"

# Throwaway builder credentials: a fresh keypair per build, rendered into the
# cloud-init seed by the template and removed with the temp dir on exit.
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT
ssh-keygen -t ed25519 -N '' -C vigil-appliance-build -f "$workdir/builder_key" -q
pubkey=$(cat "$workdir/builder_key.pub")

rm -rf "$PACKER_DIR/output"
# Pass the template by absolute path: the file provisioners resolve their
# sources against the invocation path, so a bare "." would misstat them.
packer init "$PACKER_DIR"
packer build \
  -var "accelerator=$accelerator" \
  -var "builder_ssh_pubkey=$pubkey" \
  -var "builder_ssh_private_key_path=$workdir/builder_key" \
  -var "version=$VERSION" \
  "$PACKER_DIR"

(
  cd "$PACKER_DIR/output" &&
    sha256sum "vigil-appliance-$VERSION.qcow2" > SHA256SUMS
)

echo "build.sh: built $PACKER_DIR/output/vigil-appliance-$VERSION.qcow2"
cat "$PACKER_DIR/output/SHA256SUMS"
