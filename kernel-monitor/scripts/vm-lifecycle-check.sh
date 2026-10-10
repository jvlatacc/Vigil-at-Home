#!/bin/sh
# Full-lifecycle proof for the kernel monitor, run on a Debian 12/13 VM as
# root. Attaching BPF programs and surviving a reboot need a real kernel;
# hosted CI cannot do this — see README.md ("What still needs a VM").
#
#   sudo scripts/vm-lifecycle-check.sh prepare   # build, install, assert, arm
#   sudo reboot
#   # verify runs at boot (armed below) and writes /var/log/vigil-lifecycle-check.txt
#
# prepare builds the daemon, installs it, asserts a healthy start, exercises
# the collector round-trip (forward drop-in appears with --collector, is gone
# without one), and arms a boot hook that runs `verify` after the next
# reboot. verify waits for the post-reboot monitor.health line — full or
# degraded, the mode is explicitly logged either way — uninstalls, and
# asserts zero config residue. The boot hook removes itself when done.
set -eu

if [ "$(id -u)" != 0 ]; then
  echo "Run this with sudo." >&2
  exit 1
fi

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(dirname "$HERE")
# shellcheck source=paths.sh
. "$HERE/paths.sh"

BOOT_UNIT=/etc/systemd/system/vigil-lifecycle-check.service
RESULT_FILE=/var/log/vigil-lifecycle-check.txt
INDEX="$VIG_INDEX_DIR/operations.jsonl"

die() {
  echo "FAIL: $1" >&2
  exit 1
}
must_exist() {
  [ -e "$1" ] || die "missing $1 ($2)"
}
must_absent() {
  [ ! -e "$1" ] || die "left behind: $1 ($2)"
}

# Wait up to 30s for the daemon to append a monitor.health line, considering
# only lines appended after this call (a line offset) so older runs' lines
# cannot satisfy the wait. Sets HEALTH_LINE or dies.
wait_for_health_line() {
  HEALTH_LINE=
  start=$(( $(wc -l < "$INDEX" 2>/dev/null || echo 0) + 1 ))
  i=0
  while [ "$i" -lt 30 ]; do
    HEALTH_LINE=$(tail -n +"$start" "$INDEX" 2>/dev/null |
      grep '"kind":"monitor.health"' | tail -n 1 || true)
    if [ -n "$HEALTH_LINE" ]; then
      return 0
    fi
    systemctl is-active --quiet "$VIG_SERVICE" ||
      die "monitor not running; see: journalctl -u $VIG_SERVICE"
    sleep 1
    i=$((i + 1))
  done
  die "no monitor.health line appeared in $INDEX within 30s"
}

# The health line must name its mode explicitly: degraded true or false —
# both are acceptable, silence is not (spec: full or degraded, logged).
assert_health_line() {
  mode=$(printf '%s\n' "$1" | grep -o '"degraded":\(true\|false\)' | head -n 1 | cut -d: -f2 || true)
  [ -n "$mode" ] || die "monitor.health line has no degraded field: $1"
  hooks=$(printf '%s\n' "$1" | grep -o '"hooks":\[[^]]*\]' | head -n 1 || true)
  case "$hooks" in
    '"hooks":[]'|'') die "monitor.health line lists no attached hooks: $1" ;;
  esac
  if [ "$mode" = "true" ]; then
    echo "monitor.health: DEGRADED, hooks $hooks — kprobe fallbacks indexing, explicitly logged"
  else
    echo "monitor.health: full hook set, hooks $hooks"
  fi
}

case "${1:-}" in
  prepare)
    command -v clang >/dev/null || die "build deps missing on the VM: apt-get install -y clang llvm libbpf-dev bpftool build-essential"
    make -C "$SRC"
    sh "$HERE/install.sh"

    must_exist "$VIG_UNIT" "unit not installed"
    must_exist "$VIG_DROPIN_LOCAL" "local drop-in not installed"
    must_absent "$VIG_DROPIN_FORWARD" "forward drop-in exists without a configured collector"
    must_exist "$VIG_INDEX_DIR" "index dir not created"
    systemctl is-enabled --quiet "$VIG_SERVICE" || die "service not enabled for boot"
    systemctl is-active --quiet "$VIG_SERVICE" || die "service not active"
    wait_for_health_line
    assert_health_line "$HEALTH_LINE"

    # Collector round-trip: the forward drop-in must appear with --collector
    # and disappear without one (no stale drop-in across reinstalls).
    sh "$HERE/install.sh" --collector syslog-collector.example --collector-port 6514
    must_exist "$VIG_DROPIN_FORWARD" "forward drop-in missing with a collector configured"
    grep -q 'target="syslog-collector.example"' "$VIG_DROPIN_FORWARD" ||
      die "forward drop-in lost its target"
    sh "$HERE/install.sh"
    must_absent "$VIG_DROPIN_FORWARD" "stale forward drop-in survived a collector-less reinstall"

    # Arm the post-reboot stage; it runs `verify` at boot and logs to the
    # result file.
    cat > "$BOOT_UNIT" <<UNIT
[Unit]
Description=Vigil kernel monitor lifecycle check (post-reboot stage)
[Service]
Type=oneshot
ExecStart=/bin/sh -c 'exec > ${RESULT_FILE} 2>&1; exec ${HERE}/vm-lifecycle-check.sh verify'
[Install]
WantedBy=multi-user.target
UNIT
    chmod 644 "$BOOT_UNIT"
    systemctl daemon-reload
    systemctl enable vigil-lifecycle-check.service
    echo "PREPARE OK — reboot now; verify runs at boot and writes $RESULT_FILE"
    ;;
  verify)
    systemctl is-active --quiet "$VIG_SERVICE" || die "monitor not active after reboot"
    wait_for_health_line
    assert_health_line "$HEALTH_LINE"

    sh "$HERE/uninstall.sh"
    must_absent "$VIG_UNIT" "unit"
    must_absent "$VIG_DROPIN_LOCAL" "local drop-in"
    must_absent "$VIG_DROPIN_FORWARD" "forward drop-in"
    must_absent "$VIG_ETC_DIR" "rules/config"
    must_absent "$VIG_LIBEXEC_DIR" "daemon binary"
    if systemctl is-enabled "$VIG_SERVICE" >/dev/null 2>&1; then
      die "unit still enabled after uninstall"
    fi
    echo "uninstall left zero config residue; index retained in $VIG_INDEX_DIR (user data)"

    rm -f "$BOOT_UNIT"
    systemctl daemon-reload 2>/dev/null || true
    echo "LIFECYCLE CHECK PASSED (install -> reboot -> healthy -> uninstall, no residue)"
    ;;
  *)
    echo "usage: vm-lifecycle-check.sh prepare|verify" >&2
    exit 1 ;;
esac
