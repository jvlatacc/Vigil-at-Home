# Shared harness and checks for the distro validation routine, sourced by
# validate-linux.sh. The family module (debian.sh or rhel.sh) supplies what
# differs per family — today only check_package_install — and common.sh owns
# everything else.
#
# Every path and protocol here mirrors the code it validates:
#   socket, unit, policy, libexec  — apps/desktop/helper/linux/install.sh
#   socket wire format             — packages/helper/src/{protocol,client}.ts
#   osquery config, flags, results — packages/sensors/src/osquery/linuxConfig.ts
#   fapolicyd rules and reload     — packages/helper/src/commands/fapolicyd.ts
#   osqueryd/fapolicyd candidates  — apps/desktop/src/main/onboarding/checks.ts

HELPER_UNIT=vigil-helper.service
HELPER_SOCKET=/run/vigil-helper.sock
HELPER_LIBEXEC=/usr/libexec/vigil-helper
HELPER_LIBEXEC_DIR=/usr/libexec/vigil-helper.d
HELPER_UNIT_FILE=/etc/systemd/system/vigil-helper.service
HELPER_POLICY=/usr/share/polkit-1/actions/com.vigilathome.helper.policy
HELPER_STATE=/var/lib/vigil
APP_DEB=vigil-at-home
APP_INSTALL_ROOT='/opt/Vigil at Home'

FAPOLICYD_CONF=/etc/fapolicyd/fapolicyd.conf
FAPOLICYD_RULES_DIR=/etc/fapolicyd/rules.d
# plan.ts FAPOLICYD_ALLOW_RULES: the allow-all rule behind which Vigil's own
# deny index is the only list that blocks.
FAPOLICYD_ALLOW_RULES=$FAPOLICYD_RULES_DIR/06-vigil-allow.rules
# The roundtrip never writes Vigil's own 05-vigil.rules. Its own file sorts
# before both Vigil files ("05-vigil-validate" < "05-vigil.rules" because
# '-' < '.', and both before "06-"), so the allow-all cannot mask it.
VALIDATE_RULES_FILE=$FAPOLICYD_RULES_DIR/05-vigil-validate.rules

OSQUERY_CONF=/etc/osquery/osquery.conf
OSQUERY_FLAGS=/etc/osquery/osquery.flags
OSQUERY_RESULTS=/var/log/osquery/osqueryd.results.log
# checks.ts accepts both spellings; the helper (pre-D4) only knows the first.
OSQUERYD_CANDIDATES='/opt/osquery/bin/osqueryd /usr/bin/osqueryd'
FAPOLICYD_CANDIDATES='/usr/sbin/fapolicyd /usr/bin/fapolicyd'

# How long the eBPF check waits for one launch row (the schedule runs every
# 5 s; a fresh watchdog or a busy box can take longer).
OSQUERY_WAIT=60

FAILURES=0
FAILED=()
DENY_PROBE=''
DENY_RULE_FILE=''

CHECK_NAMES=(
  'package install'
  'helper service active'
  'helper socket answers'
  'fapolicyd enforcing'
  'deny-by-hash roundtrip'
  'osquery live with an eBPF launch row'
  'uninstall cleanliness'
)

# --- harness ---------------------------------------------------------------

note() {
  printf 'NOTE %s\n' "$*"
}

run_check() {
  # run_check <name> <fn> [args...] — one line of PASS, or FAIL plus remedy.
  local name=$1
  shift
  if "$@"; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s — %s\n' "$name" "$(remedy_for "$name")"
    FAILURES=$((FAILURES + 1))
    FAILED+=("$name")
  fi
}

remedy_for() {
  case $1 in
    'package install')
      if [ "${FAMILY:-}" = rhel ]; then
        printf '%s' 'no rpm package ships yet — run the released AppImage and pass it with --package=/path/vigil-at-home_*_x86_64.AppImage (pkexec must be installed)'
      else
        printf '%s' 'install the released .deb: sudo apt install ./vigil-at-home_<version>_amd64.deb; AppImage users: pass --package=/path/vigil-at-home_*_x86_64.AppImage'
      fi
      ;;
    'helper service active')
      printf '%s' 'install the helper through Vigil'"'"'s setup (or: sudo sh "'"$APP_INSTALL_ROOT"'/resources/helper/linux/install.sh"); it must be enabled, not only running'
      ;;
    'helper socket answers')
      printf '%s' 'the helper is not answering on '"$HELPER_SOCKET"' — restart it and read its log: sudo systemctl restart '"$HELPER_UNIT"'; journalctl -u '"$HELPER_UNIT"' -n 50'
      ;;
    'fapolicyd enforcing')
      printf '%s' 'run setup'"'"'s fapolicyd step (installs it, sets trust = file, writes the allow rule, starts it); then check fapolicyd-cli --check-status and journalctl -u fapolicyd -n 50'
      ;;
    'deny-by-hash roundtrip')
      printf '%s' 'fapolicyd did not enforce the test deny rule — it must be running and enforcing (fapolicyd-cli --check-status) with trust = file set, as setup'"'"'s fapolicyd step does; see journalctl -u fapolicyd'
      ;;
    'osquery live with an eBPF launch row')
      printf '%s' 'install osquery (setup'"'"'s osquery step) and start it: sudo systemctl enable --now osqueryd; the eBPF launch row needs a kernel with BPF — see journalctl -u osqueryd -n 50'
      ;;
    'uninstall cleanliness')
      printf '%s' 'leftovers found — remove them with the official uninstall script: sudo sh "'"$APP_INSTALL_ROOT"'/resources/helper/linux/uninstall.sh" (verify the whole roundtrip with --uninstall-roundtrip)'
      ;;
    *)
      printf '%s' "no remedy registered for $1 — a check name drifted from its remedy"
      ;;
  esac
}

# --- pure helpers ----------------------------------------------------------

# plan.ts's linuxDistro() reads /etc/os-release's ID and ID_LIKE into three
# buckets: debian/ubuntu and relatives, fedora/rhel/centos and relatives,
# everything else. The routine names the dnf bucket 'rhel' (a Rocky user is
# never 'fedora'), but it is the same bucket.
osrelease_field() {
  local line value
  line=$(printf '%s\n' "$1" | grep -E "^${2}=" | head -n 1)
  [ -n "$line" ] || return 0
  value=${line#*=}
  value=${value%\"}
  value=${value#\"}
  value=${value%\'}
  value=${value#\'}
  printf '%s' "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
}

family_from_osrelease() {
  local word ids
  ids="$(osrelease_field "$1" ID) $(osrelease_field "$1" ID_LIKE)"
  for word in $ids; do
    case $word in
      debian | ubuntu) printf 'debian' && return 0 ;;
      fedora | rhel | centos) printf 'rhel' && return 0 ;;
    esac
  done
  printf 'other'
}

family_label() {
  case $1 in
    debian) printf 'Debian family (apt)' ;;
    rhel) printf 'RHEL family (dnf)' ;;
    *) printf 'unknown family' ;;
  esac
}

# --- checks shared by both families ---------------------------------------

check_helper_service() {
  # Active now and enabled for boot: an active-but-disabled helper is how a
  # machine quietly loses its protection at the next restart.
  systemctl is-active --quiet "$HELPER_UNIT" && systemctl is-enabled --quiet "$HELPER_UNIT"
}

check_helper_socket() {
  [ -S "$HELPER_SOCKET" ] || return 1
  helper_socket_answers
}

helper_socket_answers() {
  # One helper.status line in, one JSON line out (protocol.ts's envelope and
  # HelperResponse): the same ask the app makes, no approval, nothing changed.
  local req='{"id":"validate-linux","command":{"kind":"helper.status"}}'
  if command -v python3 >/dev/null 2>&1; then
    socket_answer_python "$req"
  elif command -v node >/dev/null 2>&1; then
    socket_answer_node "$req"
  elif command -v nc >/dev/null 2>&1; then
    printf '%s\n' "$req" | nc -U -w 10 "$HELPER_SOCKET" 2>/dev/null | grep -q '"ok":true'
  else
    # No tool to speak the protocol with; the check fails and says so.
    return 1
  fi
}

socket_answer_python() {
  python3 - "$HELPER_SOCKET" "$1" <<'PY'
import json, socket, sys
path, req = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(10)
try:
    s.connect(path)
    s.sendall((req + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk:
            break
        buf += chunk
    r = json.loads(buf.split(b"\n")[0])
    sys.exit(0 if r.get("id") == "validate-linux" and r.get("ok") is True else 1)
except Exception:
    sys.exit(1)
PY
}

socket_answer_node() {
  node -e '
    const net = require("node:net");
    const [path, req] = process.argv.slice(1);
    const s = net.connect(path);
    s.setEncoding("utf8");
    const giveUp = () => process.exit(1);
    s.setTimeout(10000, giveUp);
    s.on("error", giveUp);
    s.on("connect", () => s.write(req + "\n"));
    s.on("data", (d) => {
      const buf = (s.vigilBuf = (s.vigilBuf || "") + d);
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      let r;
      try {
        r = JSON.parse(buf.slice(0, nl));
      } catch {
        process.exit(1);
      }
      process.exit(r && r.id === "validate-linux" && r.ok === true ? 0 : 1);
    });
  ' "$HELPER_SOCKET" "$1"
}

package_by_appimage() {
  # The AppImage channel: the image exists, runs (executable bit), and the
  # system has pkexec for the helper install. Actually launching the GUI is
  # the manual tier — a validation routine never opens windows.
  [ -f "$OPT_APPIMAGE" ] && [ -x "$OPT_APPIMAGE" ] || return 1
  command -v pkexec >/dev/null 2>&1 || return 1
  note "AppImage mode: no package-manager record; pkexec present for the helper install"
  return 0
}

first_from() {
  # first_from <candidates-space-separated> — the first path that exists.
  local p
  for p in $1; do
    if [ -x "$p" ]; then
      printf '%s' "$p"
      return 0
    fi
  done
  return 1
}

fapolicyd_running() {
  systemctl is-active --quiet fapolicyd
}

fapolicyd_enforcing() {
  # The wizard's own readiness check: poll --check-status, because a fresh
  # fapolicyd takes a moment to come up enforcing (up to 30 s in the
  # integration test; quick once trust = file is set).
  local i
  for i in $(seq 15); do
    fapolicyd-cli --check-status >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

check_fapolicyd_enforcing() {
  first_from "$FAPOLICYD_CANDIDATES" >/dev/null || return 1
  [ -f "$FAPOLICYD_ALLOW_RULES" ] || return 1
  grep -qE '^trust[[:space:]]*=[[:space:]]*file' "$FAPOLICYD_CONF" 2>/dev/null || return 1
  fapolicyd_running || return 1
  fapolicyd_enforcing
}

check_deny_roundtrip() {
  # The enforcement path blocking depends on, replayed on this machine: a
  # deny rule naming a fresh hash refuses the next exec, and removing it lets
  # the program run again. flow.integration.test.ts proves this once per CI
  # run; this replays it anywhere. Its own rules file (see VALIDATE_RULES_FILE)
  # keeps Vigil's deny list and the allow-all rule untouched; the EXIT trap
  # removes it even when the check bails partway.
  local probe hash
  fapolicyd_running || return 1
  probe=$(mktemp /tmp/vigil-validate-deny.XXXXXX) || return 1
  DENY_PROBE=$probe
  cp /usr/bin/true "$probe" && chmod 755 "$probe" || return 1
  "$probe" >/dev/null 2>&1 || return 1
  hash=$(sha256sum "$probe" | awk '{print $1}')
  case $hash in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  DENY_RULE_FILE=$VALIDATE_RULES_FILE
  printf 'deny_audit perm=execute all : sha256hash=%s\n' "$hash" >"$DENY_RULE_FILE" || return 1
  chmod 644 "$DENY_RULE_FILE"
  fagenrules --load >/dev/null 2>&1 || return 1
  # A restart, not a SIGHUP: on fapolicyd 1.3 a reloaded rule never matches a
  # sha256hash (commands/fapolicyd.ts); a fresh start does.
  systemctl restart fapolicyd >/dev/null 2>&1 || return 1
  fapolicyd_enforcing || return 1
  if "$probe" >/dev/null 2>&1; then
    return 1
  fi
  remove_deny_rule
  "$probe" >/dev/null 2>&1 || return 1
  return 0
}

remove_deny_rule() {
  [ -n "$DENY_RULE_FILE" ] || return 0
  rm -f "$DENY_RULE_FILE"
  fagenrules --load >/dev/null 2>&1 || true
  systemctl try-restart fapolicyd >/dev/null 2>&1 || true
  DENY_RULE_FILE=''
}

cleanup() {
  remove_deny_rule
  if [ -n "$DENY_PROBE" ]; then
    rm -f "$DENY_PROBE"
  fi
}

check_osquery_live() {
  # osquery not just installed but seeing launches: the schedule's
  # vigil_process_events (bpf_process_events, every 5 s) must log a row for a
  # launch this check itself made. An osqueryd that never rows is the
  # "silent eBPF on exotic kernels" failure nothing else catches.
  first_from "$OSQUERYD_CANDIDATES" >/dev/null || return 1
  [ -f "$OSQUERY_CONF" ] || return 1
  grep -q vigil_process_events "$OSQUERY_CONF" || return 1
  grep -q 'enable_bpf_events=true' "$OSQUERY_FLAGS" 2>/dev/null || return 1
  systemctl is-active --quiet osqueryd || return 1
  osquery_sees_a_launch
}

osquery_sees_a_launch() {
  local probe name deadline
  probe=$(mktemp /tmp/vigil-validate-osquery.XXXXXX) || return 1
  cp /usr/bin/true "$probe" && chmod 755 "$probe" || {
    rm -f "$probe"
    return 1
  }
  name=${probe##*/}
  "$probe" >/dev/null 2>&1
  deadline=$(( $(date +%s) + OSQUERY_WAIT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -f "$OSQUERY_RESULTS" ] && grep -Fq -- "$name" "$OSQUERY_RESULTS" 2>/dev/null; then
      rm -f "$probe"
      return 0
    fi
    sleep 3
  done
  rm -f "$probe"
  return 1
}

helper_installed() {
  [ -f "$HELPER_LIBEXEC" ] || [ -S "$HELPER_SOCKET" ] || [ -f "$HELPER_UNIT_FILE" ]
}

first_uninstall_script() {
  if [ -n "$OPT_UNINSTALL_SCRIPT" ]; then
    [ -f "$OPT_UNINSTALL_SCRIPT" ] && {
      printf '%s' "$OPT_UNINSTALL_SCRIPT"
      return 0
    }
    return 1
  fi
  [ -f "$APP_INSTALL_ROOT/resources/helper/linux/uninstall.sh" ] && {
    printf '%s' "$APP_INSTALL_ROOT/resources/helper/linux/uninstall.sh"
    return 0
  }
  return 1
}

check_uninstall_cleanliness() {
  # Safe by default. With the helper installed, the check only requires that
  # the official uninstall script is where the app shipped it — the real
  # uninstall is destructive, so it runs only with --uninstall-roundtrip.
  # With no helper installed, assert nothing Vigil installs was left behind.
  if [ -n "$OPT_ROUNDTRIP" ]; then
    uninstall_roundtrip
  elif helper_installed; then
    first_uninstall_script >/dev/null || return 1
    note "helper is installed; --uninstall-roundtrip verifies the uninstall for real"
    return 0
  else
    assert_no_leftovers
  fi
}

assert_no_leftovers() {
  local p bad=''
  for p in \
    "$HELPER_LIBEXEC" \
    "$HELPER_LIBEXEC_DIR" \
    "$HELPER_UNIT_FILE" \
    "$HELPER_POLICY" \
    "$HELPER_SOCKET" \
    "$FAPOLICYD_RULES_DIR/05-vigil.rules" \
    "$FAPOLICYD_ALLOW_RULES"; do
    if [ -e "$p" ]; then
      bad="$bad $p"
    fi
  done
  # A user's own osquery config is not a leftover; Vigil's is, when its
  # marker query is in it and the .before-vigil backup is gone.
  if [ -f "$OSQUERY_CONF" ] && grep -q vigil_process_events "$OSQUERY_CONF"; then
    bad="$bad $OSQUERY_CONF"
  fi
  if [ -n "$bad" ]; then
    note "left behind after uninstall:$bad"
    return 1
  fi
  # Both of these stay by design (uninstall.sh's header): quarantined files
  # must survive, and nftables blocks linger until reboot.
  [ -d "$HELPER_STATE" ] && note "quarantined files remain in $HELPER_STATE, as documented"
  if command -v nft >/dev/null 2>&1 && nft list table inet vigil >/dev/null 2>&1; then
    note "Vigil's nftables table survives until reboot, as documented"
  fi
  return 0
}

uninstall_roundtrip() {
  local script install_sh
  script=$(first_uninstall_script) || return 1
  sh "$script" || return 1
  assert_no_leftovers || return 1
  install_sh=$(dirname "$script")/install.sh
  if [ -f "$install_sh" ]; then
    sh "$install_sh" || return 1
    check_helper_service || return 1
    helper_socket_answers || return 1
  else
    note "no install.sh next to it — the helper stays uninstalled; reinstall per the getting-started guide"
  fi
  return 0
}

run_all_checks() {
  run_check 'package install' check_package_install
  run_check 'helper service active' check_helper_service
  run_check 'helper socket answers' check_helper_socket
  run_check 'fapolicyd enforcing' check_fapolicyd_enforcing
  run_check 'deny-by-hash roundtrip' check_deny_roundtrip
  run_check 'osquery live with an eBPF launch row' check_osquery_live
  run_check 'uninstall cleanliness' check_uninstall_cleanliness
  [ "$FAILURES" -eq 0 ]
}

# --- self-test -------------------------------------------------------------

self_test() {
  # Verifies the harness itself, needing no root and touching nothing: the
  # real checks are stubbed out, so what is proven is family detection, the
  # remedy registry, and the pass/fail wiring — including the
  # sabotage-and-expect-fail property CI relies on.
  local failures=0
  fam_case() {
    local got
    got=$(family_from_osrelease "$2")
    if [ "$got" != "$1" ]; then
      printf 'FAIL self-test: [%s] detected as %s, wanted %s\n' "$2" "$got" "$1"
      failures=$((failures + 1))
    fi
  }
  # Fixtures are real os-release text (multi-line, quoted literally — the
  # same shape family_from_osrelease parses from /etc/os-release).
  fam_case debian 'ID=debian
'
  fam_case debian 'ID=ubuntu
VERSION_ID="24.04"
'
  fam_case debian 'ID=linuxmint
ID_LIKE="debian"
'
  fam_case debian 'PRETTY_NAME="Ubuntu 24.04 LTS"
ID=ubuntu
'
  fam_case rhel 'ID=fedora
'
  fam_case rhel 'ID="rocky"
ID_LIKE="rhel centos fedora"
'
  fam_case rhel 'ID=almalinux
ID_LIKE="rhel centos fedora"
'
  fam_case rhel 'ID="rhel"
VERSION_ID="9.4"
'
  fam_case other 'ID=arch
'
  fam_case other 'ID=opensuse-leap
ID_LIKE="suse opensuse"
'
  fam_case other ''

  local c
  for c in "${CHECK_NAMES[@]}"; do
    if [ -z "$(remedy_for "$c")" ]; then
      printf 'FAIL self-test: no remedy registered for %s\n' "$c"
      failures=$((failures + 1))
    fi
  done

  local out status
  out=$(
    check_package_install() { return 0; }
    check_helper_service() { return 0; }
    check_helper_socket() { return 0; }
    check_fapolicyd_enforcing() { return 0; }
    check_deny_roundtrip() { return 0; }
    check_osquery_live() { return 0; }
    check_uninstall_cleanliness() { return 0; }
    run_all_checks
  )
  status=$?
  if [ "$status" -ne 0 ] || [ "$(printf '%s\n' "$out" | grep -c '^PASS ')" -ne "${#CHECK_NAMES[@]}" ]; then
    printf 'FAIL self-test: all checks passing did not pass the run:\n%s\n' "$out"
    failures=$((failures + 1))
  fi

  out=$(
    check_package_install() { return 0; }
    check_helper_service() { return 0; }
    check_helper_socket() { return 0; }
    check_fapolicyd_enforcing() { return 0; }
    check_deny_roundtrip() { return 0; }
    check_osquery_live() { return 0; }
    check_uninstall_cleanliness() { return 1; }
    run_all_checks
  )
  status=$?
  if [ "$status" -eq 0 ] || [ "$(printf '%s\n' "$out" | grep -c '^FAIL ')" -ne 1 ]; then
    printf 'FAIL self-test: a sabotaged check did not fail the run:\n%s\n' "$out"
    failures=$((failures + 1))
  fi

  if [ "$failures" -eq 0 ]; then
    printf 'Self-test passed: family detection, remedies and the pass/fail wiring behave.\n'
    return 0
  fi
  printf 'Self-test failed (%s assertion(s)).\n' "$failures"
  return 1
}
