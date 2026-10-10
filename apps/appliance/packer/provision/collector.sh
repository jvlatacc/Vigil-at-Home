#!/usr/bin/env bash
# Bundles the collector service and installs it as a hardened systemd
# service. Runs inside the build VM (Packer shell provisioner), after
# node.sh has installed the pinned Node runtime.
#
# The bundle options mirror apps/desktop/scripts/bundle-options.mjs
# (BUNDLE_OPTIONS): the repo's shipping-bundle precedent. Dependencies are
# installed with npm ci from the committed lockfile, so versions are pinned
# and every tarball is verified against the lockfile's integrity hashes.

set -euo pipefail

BUILD_DIR=/tmp/vigil-build
BUNDLE_DIR=/opt/vigil-appliance
SERVICE_USER=vigil-appliance

# Bundle dependencies: pinned + integrity-checked via npm ci.
cd "$BUILD_DIR"
npm ci --no-audit --no-fund

# Unprivileged service user. The home directory under /var/lib is owned and
# managed by systemd's StateDirectory at runtime; the user itself needs no
# login shell.
useradd --system --user-group \
  --home-dir "/var/lib/${SERVICE_USER}" \
  --shell /usr/sbin/nologin "$SERVICE_USER"

# esbuild bundle of the service entrypoint — same options as the repo's
# BUNDLE_OPTIONS (the createRequire banner keeps bundled CommonJS
# dependencies working under ESM).
mkdir -p "$BUNDLE_DIR"
./node_modules/.bin/esbuild src/service.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  --legal-comments=inline \
  --banner:js='import { createRequire as __vigilRequire } from "node:module"; const require = __vigilRequire(import.meta.url);' \
  --outfile="$BUNDLE_DIR/collector.mjs"
chown root:root "$BUNDLE_DIR/collector.mjs"
chmod 0644 "$BUNDLE_DIR/collector.mjs"

# Configuration lives in /etc; cloud-init owns appliance.env at deployment
# (the service never mutates it — see the spec's config-layer contract).
mkdir -p /etc/vigil-appliance
chmod 0755 /etc/vigil-appliance

cat > /etc/systemd/system/vigil-appliance.service <<'UNIT'
[Unit]
Description=Vigil-at-Home appliance collector (NetFlow and NDJSON ingest to S3)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/node /opt/vigil-appliance/collector.mjs
EnvironmentFile=/etc/vigil-appliance/appliance.env
User=vigil-appliance
Group=vigil-appliance
StateDirectory=vigil-appliance

# Hardening. The service binds only unprivileged ports (2550/UDP NetFlow,
# 2551/TCP ingest), so it needs no capabilities and no root.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
RestrictAddressFamilies=AF_INET AF_INET6
CapabilityBoundingSet=
UMask=0077

Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/vigil-appliance.service

systemctl daemon-reload
systemctl enable vigil-appliance.service

# The staged source and build deps do not ship in the image.
rm -rf "$BUILD_DIR"
