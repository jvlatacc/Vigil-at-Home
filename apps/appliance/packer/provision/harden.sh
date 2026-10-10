#!/usr/bin/env bash
# Strips build-boot state so the artifact is a clean, cloud-init-managed
# template. Runs last, after node.sh and collector.sh. cloud-init runs again
# from scratch at the deployment's first boot with the operator's user-data.

set -euo pipefail

# 1. Strip the throwaway builder account's credentials now, and arrange its
#    deletion at the next boot. It cannot be deleted here: the provisioners
#    connect as builder, and userdel refuses while any process still holds
#    the uid ("user is currently used by process" — our own sshd session).
#    What must never survive is the credential: the per-build key goes with
#    the home directory now, the sudoers rule goes now, and the keyless,
#    password-locked account itself is removed at first boot, when no
#    session can hold it.
rm -rf /home/builder
sudoers=/etc/sudoers.d/90-cloud-init-users
if [[ -f $sudoers ]] && grep -q '^builder\b' "$sudoers"; then
  sed -i '/^builder\b/d' "$sudoers"
  [[ -s $sudoers ]] || rm -f "$sudoers"
fi
mkdir -p /var/lib/cloud/scripts/per-boot
cat > /var/lib/cloud/scripts/per-boot/00-remove-builder.sh <<'PERBOOT'
#!/bin/sh
# Left over from the image build: the throwaway builder account could not be
# deleted during provisioning (its own SSH session held the uid), so the
# deletion runs at this boot, when nothing holds it. No-op on later boots.
if getent passwd builder >/dev/null; then
    pkill -KILL -u builder 2>/dev/null || true
    userdel --remove builder
    rm -rf /home/builder
fi
PERBOOT
chmod 0755 /var/lib/cloud/scripts/per-boot/00-remove-builder.sh

# 2. SSH: no root login, no password authentication (keys only).
cat > /etc/ssh/sshd_config.d/60-vigil-hardening.conf <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
SSHD
chmod 0644 /etc/ssh/sshd_config.d/60-vigil-hardening.conf
sshd -t

# 3. Neutral machine identity for a generic image: cloud-init regenerates
#    instance state on the next boot; an empty /etc/machine-id makes systemd
#    provision a fresh one at first boot.
cloud-init clean --logs --seed
truncate --size=0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
echo vigil-appliance > /etc/hostname

# 4. Caches, package lists, npm caches, logs.
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -rf /root/.npm /root/.cache
find /var/log -type f -exec truncate --size=0 {} +

# 5. Leftover build staging (collector.sh removes it too; this is defensive).
rm -rf /tmp/vigil-build
