#!/bin/sh
# Removes the Vigil kernel monitor. Run it with sudo.
# Config goes away entirely: the unit, both rsyslog drop-ins, the rules, and
# the daemon binary. Anything Vigil found already installed is put back from
# its *.before-vigil snapshot. Data the user owns stays: the operations index
# in /var/lib/vigil/kernel-monitor and /var/log/vigil/kernel-monitor.log.
set -eu

if [ "$(id -u)" != 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=paths.sh
. "$HERE/paths.sh"

systemctl disable --now "$VIG_SERVICE" 2>/dev/null || true

# Restore a snapshot if one exists (the file was here before Vigil), else the
# path is ours and goes.
restore_or_remove() {
  if [ -f "$1.before-vigil" ]; then
    mv -f "$1.before-vigil" "$1"
  else
    rm -f "$1"
  fi
}

restore_or_remove "$VIG_UNIT"
systemctl daemon-reload 2>/dev/null || true
restore_or_remove "$VIG_DROPIN_LOCAL"
restore_or_remove "$VIG_DROPIN_FORWARD"

# /etc/vigil/kernel-monitor is wholly the monitor's: nothing else writes
# there. Rules that predate Vigil are restored; our files are removed; the
# directory only survives when restored foreign files remain in it.
for f in "$VIG_RULES_DIR"/*.json; do
  [ -f "$f" ] || continue
  if [ -f "$f.before-vigil" ]; then
    mv -f "$f.before-vigil" "$f"
  else
    rm -f "$f"
  fi
done
rmdir "$VIG_RULES_DIR" "$VIG_ETC_DIR" 2>/dev/null || true
rmdir /etc/vigil 2>/dev/null || true

rm -rf "$VIG_LIBEXEC_DIR"
# Undelivered forward-queue files belong to our (now removed) forwarding
# action; the rest of the rsyslog spool is not ours to touch.
rm -f /var/spool/rsyslog/vigil-fwd*

if systemctl is-active --quiet rsyslog.service 2>/dev/null; then
  systemctl restart rsyslog.service
fi

echo "Vigil kernel monitor removed. The operations index is still in $VIG_INDEX_DIR (delete it yourself if you want it gone); the log is still in /var/log/vigil."
