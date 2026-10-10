#!/usr/bin/env bash
# Strips build-boot state so the artifact is a clean, cloud-init-managed
# template. Runs last, after node.sh and collector.sh. cloud-init runs again
# from scratch at the deployment's first boot with the operator's user-data.

set -euo pipefail

# 1. Remove the throwaway builder user; its authorized_keys go with the
#    home directory. No build-boot credential survives in the image.
if getent passwd builder >/dev/null; then
  userdel --remove builder
fi
rm -rf /home/builder

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
