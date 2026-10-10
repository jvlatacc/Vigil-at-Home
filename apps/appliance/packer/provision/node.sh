#!/usr/bin/env bash
# Installs the checksum-pinned Node.js runtime the appliance service runs on.
#
# Pin provenance: SHA-256 fetched 2026-10-10 from the official Node.js sums
# (https://nodejs.org/dist/v22.22.2/SHASUMS256.txt) for
# node-v22.22.2-linux-x64.tar.gz; it is the same pin as
# apps/desktop/scripts/build-helper.mjs (HELPER_NODE_SHA256), the repo's
# runtime-pinning precedent. The hash is pinned here rather than trusting a
# checksum file fetched at build time — a tampered download cannot pass by
# bringing its own sums.
#
# The image is amd64 (the QEMU source boots the amd64 Debian cloud image).

set -euo pipefail

NODE_VERSION=v22.22.2
NODE_TARBALL="node-${NODE_VERSION}-linux-x64.tar.gz"
NODE_SHA256=978978a635eef872fa68beae09f0aad0bbbae6757e444da80b570964a97e62a3

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/$NODE_TARBALL" \
  "https://nodejs.org/dist/${NODE_VERSION}/${NODE_TARBALL}"
printf '%s  %s\n' "$NODE_SHA256" "$tmp/$NODE_TARBALL" | sha256sum --check -

mkdir -p /opt
tar -xzf "$tmp/$NODE_TARBALL" -C /opt
ln -sfn "/opt/node-${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node
ln -sfn "/opt/node-${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm
ln -sfn "/opt/node-${NODE_VERSION}-linux-x64/bin/corepack" /usr/local/bin/corepack

node --version
