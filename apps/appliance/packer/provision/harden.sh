#!/usr/bin/env bash
# Strips build-boot state so the artifact is a clean, cloud-init-managed
# template. Runs last, after node.sh and collector.sh. cloud-init runs again
# from scratch at the deployment's first boot with the operator's user-data.

set -euo pipefail

# 1. SSH: no root login, no password authentication (keys only).
cat > /etc/ssh/sshd_config.d/60-vigil-hardening.conf <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
SSHD
chmod 0644 /etc/ssh/sshd_config.d/60-vigil-hardening.conf
sshd -t

# 2. Neutral machine identity for a generic image: cloud-init regenerates
#    instance state on the next boot; an empty /etc/machine-id makes systemd
#    provision a fresh one at first boot.
cloud-init clean --logs --seed
truncate --size=0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
echo vigil-appliance > /etc/hostname

# 3. Arrange the throwaway builder account's removal at the appliance's
#    first boot. Nothing of the account can be removed during provisioning:
#      - the account itself: userdel refuses while the provisioners are
#        connected as builder ("user is currently used by process"), and
#      - its home (with the per-build SSH key) and sudoers rule: removing
#        them here would break the very next thing Packer does — the
#        shutdown command runs over a fresh SSH session as builder
#        (`sudo shutdown -P now`), which needs exactly that key and that
#        sudo rule.
#    So the per-boot script below removes the sudoers rule, the home
#    directory with the key, and the account, at the first boot when no
#    session can hold the uid. The image at rest carries the key's public
#    half only — its private half is destroyed with build.sh's temp dir —
#    so nothing in the artifact is a usable credential.
#    Installed AFTER `cloud-init clean` (step 2), which wipes
#    /var/lib/cloud — including anything planted there earlier.
mkdir -p /var/lib/cloud/scripts/per-boot
cat > /var/lib/cloud/scripts/per-boot/00-remove-builder.sh <<'PERBOOT'
#!/bin/sh
# Left over from the image build: the throwaway builder account, its home
# directory with the per-build SSH key, and its sudoers rule could not be
# removed during provisioning (the account was in use by its own SSH
# session, and Packer's shutdown command still needed the key and sudo).
# This first-boot pass removes them when nothing holds the uid. No-op on
# later boots.
if getent passwd builder >/dev/null; then
    pkill -KILL -u builder 2>/dev/null || true
    userdel --remove builder
    rm -rf /home/builder
    sudoers=/etc/sudoers.d/90-cloud-init-users
    if [ -f "$sudoers" ] && grep -q '^builder\b' "$sudoers"; then
        sed -i '/^builder\b/d' "$sudoers"
        [ -s "$sudoers" ] || rm -f "$sudoers"
    fi
fi
PERBOOT
chmod 0755 /var/lib/cloud/scripts/per-boot/00-remove-builder.sh

# 4. Caches, package lists, npm caches, logs.
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /root/.npm /root/.cache
find /var/log -type f -exec truncate --size=0 {} +

# 5. Leftover build staging (collector.sh removes it too; this is defensive).
rm -rf /tmp/vigil-build
