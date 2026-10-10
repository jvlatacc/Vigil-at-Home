#!/bin/sh
# Host-runnable packaging checks for the kernel monitor — CI runs these on
# every push and they need no kernel privileges:
#   1. shellcheck over every script here (sources followed)
#   2. systemd-analyze verify of the unit, inside a stubbed root so the
#      ExecStart target exists and the sandbox's own systemd parses it
#   3. rsyslog config syntax for the local drop-in and the forward template
#   4. uninstall-twice idempotency (root): the second run must be a no-op
#      that exits 0 and leaves no config residue
# What this cannot check is live-kernel behavior; that proof is
# vm-lifecycle-check.sh's job on a Debian VM.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(dirname "$HERE")
# shellcheck source=paths.sh
. "$HERE/paths.sh"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}
step() {
  printf '\n== %s ==\n' "$1"
}

step "shellcheck (sources followed)"
command -v shellcheck >/dev/null || fail "shellcheck not installed (apt-get install shellcheck)"
shellcheck -x --source-path="$HERE" "$HERE"/*.sh
echo "shellcheck clean (every script, sources followed)"

step "systemd unit (systemd-analyze verify in a stubbed root)"
command -v systemd-analyze >/dev/null || fail "systemd-analyze not installed"
VERIFY_ROOT=$(mktemp -d)
trap 'rm -rf "$VERIFY_ROOT"' EXIT
# A minimal tree: the unit, a stub daemon at the installed path (so the
# shebang resolves), and the host's systemd units so dependency targets
# resolve. The interpreter and vendor units come from this machine, so this
# verifies against the systemd actually present here.
mkdir -p "$VERIFY_ROOT/etc/systemd/system" \
  "$VERIFY_ROOT/usr/libexec/vigil-kernel-monitor" \
  "$VERIFY_ROOT/usr/lib/systemd" \
  "$VERIFY_ROOT/var/lib/vigil/kernel-monitor"
cp -a /usr/lib/systemd/system "$VERIFY_ROOT/usr/lib/systemd/system"
ln -s /usr/bin "$VERIFY_ROOT/usr/bin"
ln -s /usr/bin "$VERIFY_ROOT/bin"
printf '#!/bin/sh\nexec sleep 0\n' \
  > "$VERIFY_ROOT/usr/libexec/vigil-kernel-monitor/vigil-kernel-monitor"
chmod 755 "$VERIFY_ROOT/usr/libexec/vigil-kernel-monitor/vigil-kernel-monitor"
cp "$SRC/systemd/vigil-kernel-monitor.service" \
  "$VERIFY_ROOT/etc/systemd/system/vigil-kernel-monitor.service"
set +e
verify_out=$(systemd-analyze verify --root="$VERIFY_ROOT" \
  etc/systemd/system/vigil-kernel-monitor.service 2>&1)
verify_rc=$?
set -e
# verify exits 0 even for some parse errors (bad enum values), so any output
# at all is a failure here.
if [ "$verify_rc" -ne 0 ] || [ -n "$verify_out" ]; then
  printf '%s\n' "$verify_out"
  fail "systemd-analyze verify (rc=$verify_rc)"
fi
echo "unit verified"

step "rsyslog drop-in syntax (probe copies in /etc/rsyslog.d)"
command -v rsyslogd >/dev/null || fail "rsyslogd not installed (apt-get install rsyslog)"
check_rsyslog() {
  src=$1
  label=$2
  # rsyslogd may run confined (e.g. the Ubuntu AppArmor profile): a probe
  # copy in the checkout or /tmp gets EACCES even under sudo. Installed
  # drop-ins live in /etc/rsyslog.d, so probe a copy from there.
  probe=/etc/rsyslog.d/zz-vigil-packaging-check.conf
  errlog=$(mktemp)
  install -m 644 "$src" "$probe"
  set +e
  rsyslogd -N1 -f "$probe" 2>"$errlog"
  rc=$?
  set -e
  rm -f "$probe"
  if [ "$rc" -ne 0 ] || grep -qi 'error' "$errlog"; then
    sed 's/^/  /' "$errlog" >&2
    rm -f "$errlog"
    fail "$label does not parse (rsyslogd -N1 rc=$rc)"
  fi
  rm -f "$errlog"
}
check_rsyslog "$SRC/rsyslog/vigil-kernel-monitor.conf" "local drop-in"
FWD_SAMPLE=$(mktemp)
sed -e 's/@VIG_COLLECTOR_TARGET@/collector.example/' \
  -e 's/@VIG_COLLECTOR_PORT@/6514/' \
  "$SRC/rsyslog/vigil-forward.conf.in" > "$FWD_SAMPLE"
check_rsyslog "$FWD_SAMPLE" "forward template"
rm -f "$FWD_SAMPLE"
echo "both drop-ins parse"

step "uninstall idempotency (second run must be a no-op, exit 0)"
installed_snapshot() {
  for path in "$VIG_UNIT" "$VIG_DROPIN_LOCAL" "$VIG_DROPIN_FORWARD" \
    "$VIG_ETC_DIR" "$VIG_LIBEXEC_DIR"; do
    [ -e "$path" ] && echo "$path"
  done
  return 0
}
if [ "$(id -u)" -ne 0 ]; then
  echo "SKIP: run this script as root (sudo) to include the uninstall idempotency test."
else
  before=$(installed_snapshot)
  sh "$HERE/uninstall.sh" || fail "first uninstall exited non-zero"
  sh "$HERE/uninstall.sh" || fail "second uninstall exited non-zero"
  after=$(installed_snapshot)
  [ "$before" = "$after" ] || fail "second uninstall changed system state"
  residue=$(installed_snapshot)
  [ -z "$residue" ] || {
    printf '%s\n' "$residue"
    fail "config residue left behind"
  }
  echo "uninstall is idempotent: two runs, exit 0, no config residue"
fi

printf '\n== packaging checks passed ==\n'
