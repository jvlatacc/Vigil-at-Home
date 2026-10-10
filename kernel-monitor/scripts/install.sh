#!/bin/sh
# Installs the Vigil kernel monitor (eBPF operations index + alerts) as a root
# systemd service on Debian 12/13 x64. Run it as root after building:
#   make -C kernel-monitor
#   sudo sh kernel-monitor/scripts/install.sh [--collector HOST --collector-port PORT]
# Everything it installs is root-owned; any pre-existing file it touches is
# kept as *.before-vigil. uninstall.sh (next to this file) reverses it.
# Without --collector the daemon only writes its index and the local rsyslog
# drop-in; with --collector a queued TLS forwarder is added.
set -eu

if [ "$(id -u)" != 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(dirname "$HERE")
# shellcheck source=paths.sh
. "$HERE/paths.sh"

COLLECTOR=
COLLECTOR_PORT=6514
while [ $# -gt 0 ]; do
  case "$1" in
    --collector)
      [ $# -ge 2 ] || { echo "--collector needs a host" >&2; exit 1; }
      COLLECTOR=$2; shift 2 ;;
    --collector-port)
      [ $# -ge 2 ] || { echo "--collector-port needs a number" >&2; exit 1; }
      COLLECTOR_PORT=$2; shift 2 ;;
    --help|-h)
      echo "usage: install.sh [--collector HOST] [--collector-port PORT]" >&2
      exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "usage: install.sh [--collector HOST] [--collector-port PORT]" >&2
      exit 1 ;;
  esac
done

# The collector name is substituted into an rsyslog quoted string, so only
# host characters are allowed — no spaces, quotes, backslashes, or '$'.
case "$COLLECTOR" in
  '') ;;
  *[!A-Za-z0-9.:-]*)
    echo "Collector host may only contain letters, digits, dots, dashes and colons." >&2
    exit 1 ;;
esac
case "$COLLECTOR_PORT" in
  ''|*[!0-9]*) echo "Collector port must be numeric." >&2; exit 1 ;;
  *) if [ "$COLLECTOR_PORT" -lt 1 ] || [ "$COLLECTOR_PORT" -gt 65535 ]; then
       echo "Collector port must be between 1 and 65535." >&2
       exit 1
     fi ;;
esac

# The binary comes from the build, the rest from this tree.
for f in "$SRC/build/vigil-kernel-monitor" "$SRC/systemd/vigil-kernel-monitor.service" \
  "$SRC/rsyslog/vigil-kernel-monitor.conf" "$SRC/rsyslog/vigil-forward.conf.in"; do
  [ -f "$f" ] || { echo "Missing $f — run make in kernel-monitor/ first." >&2; exit 1; }
done
set -- "$SRC"/rules/*.json
[ -f "$1" ] || { echo "Missing $SRC/rules/*.json — the alert rules ship with the repo." >&2; exit 1; }
command -v systemctl >/dev/null || { echo "The monitor needs systemd." >&2; exit 1; }

# Keep the pre-Vigil state of a shared file we are about to replace. Only the
# first install snapshots it; later installs never overwrite the snapshot.
backup() {
  if [ -f "$1" ] && [ ! -f "$1.before-vigil" ]; then
    cp -p "$1" "$1.before-vigil"
  fi
}

install -d -o root -g root -m 755 /etc/rsyslog.d "$(dirname "$VIG_UNIT")"
install -d -o root -g root -m 755 "$VIG_LIBEXEC_DIR" "$VIG_ETC_DIR" "$VIG_RULES_DIR"
# The unit's ReadWritePaths names the index dir, so it must exist before the
# service first starts under ProtectSystem=strict.
install -d -o root -g root -m 755 "$VIG_INDEX_DIR"

backup "$VIG_UNIT"
install -o root -g root -m 644 "$SRC/systemd/vigil-kernel-monitor.service" "$VIG_UNIT"
backup "$VIG_DROPIN_LOCAL"
install -o root -g root -m 644 "$SRC/rsyslog/vigil-kernel-monitor.conf" "$VIG_DROPIN_LOCAL"
install -o root -g root -m 755 "$SRC/build/vigil-kernel-monitor" \
  "$VIG_LIBEXEC_DIR/vigil-kernel-monitor"
for rule in "$SRC"/rules/*.json; do
  backup "$VIG_RULES_DIR/$(basename "$rule")"
  install -o root -g root -m 644 "$rule" "$VIG_RULES_DIR/$(basename "$rule")"
done

# The forwarder exists only while a collector is configured: writing it with
# --collector and removing it without keeps repeat installs convergent.
if [ -n "$COLLECTOR" ]; then
  sed -e "s/@VIG_COLLECTOR_TARGET@/$COLLECTOR/" \
      -e "s/@VIG_COLLECTOR_PORT@/$COLLECTOR_PORT/" \
      "$SRC/rsyslog/vigil-forward.conf.in" > "$VIG_DROPIN_FORWARD"
  chown root:root "$VIG_DROPIN_FORWARD"
  chmod 644 "$VIG_DROPIN_FORWARD"
else
  rm -f "$VIG_DROPIN_FORWARD"
fi

# Reload rsyslog so the drop-ins take effect now, not on its next restart.
if systemctl is-active --quiet rsyslog.service; then
  systemctl restart rsyslog.service
fi

systemctl daemon-reload
systemctl enable "$VIG_SERVICE"
systemctl restart "$VIG_SERVICE"

# The daemon writes one monitor.health line at start. Only lines appended
# after the restart count — older runs left their own behind in the index.
first_new_line=$(( $(wc -l < "$VIG_INDEX_DIR/operations.jsonl" 2>/dev/null || echo 0) + 1 ))
health=
i=0
while [ "$i" -lt 30 ]; do
  health=$(tail -n +"$first_new_line" "$VIG_INDEX_DIR/operations.jsonl" 2>/dev/null |
    grep '"kind":"monitor.health"' | tail -n 1 || true)
  [ -n "$health" ] && break
  if ! systemctl is-active --quiet "$VIG_SERVICE"; then
    echo "The monitor did not stay up. See: journalctl -u $VIG_SERVICE" >&2
    exit 1
  fi
  sleep 1
  i=$((i + 1))
done
if [ -z "$health" ]; then
  echo "The monitor never reported health. See: journalctl -u $VIG_SERVICE" >&2
  exit 1
fi
mode=$(printf '%s' "$health" | grep -o '"degraded":\(true\|false\)' | head -n 1 | cut -d: -f2 || true)
case "$mode" in
  false) echo "Vigil kernel monitor installed and running (full hook set)." ;;
  true)  echo "Vigil kernel monitor installed and running (DEGRADED — some hooks missing; see the monitor.health line)." ;;
  *)     echo "Vigil kernel monitor installed and running (health line lacks a degraded field)." ;;
esac
if [ -n "$COLLECTOR" ]; then
  echo "Forwarding VIGOP/VIGALERT to $COLLECTOR:$COLLECTOR_PORT over queued TLS."
fi
