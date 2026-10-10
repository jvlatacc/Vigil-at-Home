# Shared harness for the daemon bats files (component spec art_4ou8t1mZ):
# stub softflowd/softflowctl binaries, fixture configs, and small health-JSON
# assertions. Hermetic by construction — no network, no real binaries; the
# daemon's overridable VIGIL_FLOW_* locations are the test seam.

SUPERVISOR=$BATS_TEST_DIRNAME/../share/vigil-flow-supervisor.sh
CTL=$BATS_TEST_DIRNAME/../share/vigil-flow-ctl.sh

daemon_setup() {
  TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/vigil-flow-daemon.XXXXXX")
  STUB_BIN=$TEST_TMP/bin
  RUN_DIR=$TEST_TMP/run
  BPF_DIR=$TEST_TMP/dev
  mkdir -p "$STUB_BIN" "$RUN_DIR" "$BPF_DIR"
  : > "$BPF_DIR/bpf0"
  export VIGIL_FLOW_TEST_IFCONFIG_OUTPUT="lo0 lan0 wan0"

  cat > "$STUB_BIN/ifconfig" <<'STUB'
#!/bin/sh
printf '%s\n' "$VIGIL_FLOW_TEST_IFCONFIG_OUTPUT"
STUB
  printf '#!/bin/sh\nexit 0\n' > "$STUB_BIN/getent"
  # softflowd stub: records its argv for contract assertions, then idles
  # until signalled (mimicking the spec's foreground child).
  cat > "$STUB_BIN/softflowd" <<STUB
#!/bin/sh
trap 'exit 0' TERM INT
printf '%s\n' "\$@" > "$TEST_TMP/softflowd-argv"
while :; do sleep 3600; done
STUB
  cat > "$STUB_BIN/softflowctl" <<STUB
#!/bin/sh
if [ "\${VIGIL_FLOW_TEST_CTL_FAIL:-0}" = "1" ]; then
  exit 1
fi
if [ "\${1:-}" = "shutdown" ]; then
  exit 0
fi
printf '%b' "\$VIGIL_FLOW_TEST_STATISTICS"
STUB
  chmod +x "$STUB_BIN/ifconfig" "$STUB_BIN/getent" "$STUB_BIN/softflowd" "$STUB_BIN/softflowctl"

  export VIGIL_FLOW_TEST_STATISTICS="Number of active flows: 42
Flows expired: 7 (0 forced)
"
  export VIGIL_FLOW_CONFIG=$TEST_TMP/vigil-flow.conf
  export VIGIL_FLOW_STATUS_FILE=$RUN_DIR/status.json
  export VIGIL_FLOW_SUPERVISOR_PIDFILE=$RUN_DIR/vigil-flow-supervisor.pid
  export VIGIL_FLOW_SOFTFLOWD_PIDFILE=$RUN_DIR/vigil-flow-softflowd.pid
  export VIGIL_FLOW_SOFTFLOWD_CTLFILE=$RUN_DIR/vigil-flow-softflowd.ctl
  export VIGIL_FLOW_SOFTFLOWD=$STUB_BIN/softflowd
  export VIGIL_FLOW_SOFTFLOWCTL=$STUB_BIN/softflowctl
  export VIGIL_FLOW_IFCONFIG=$STUB_BIN/ifconfig
  export VIGIL_FLOW_BPF_DIR=$BPF_DIR
  export VIGIL_FLOW_POLL_INTERVAL=0.1
  export VIGIL_FLOW_MAX_CONSEC_RESTARTS=5
  export VIGIL_FLOW_MAX_BACKOFF=2
  write_fixture_config
  # Load the supervisor as a library — the same skip-main seam the
  # installer tests use.
  # shellcheck disable=SC1090
  VIGIL_FLOW_SKIP_MAIN=1 . "$SUPERVISOR"
}

daemon_teardown() {
  # Kill anything this test started (supervisor + stub softflowd children)
  # so the suite leaves no stray processes behind.
  if [ -n "${VIGIL_FLOW_SUPERVISOR_PIDFILE:-}" ] && [ -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ]; then
    _dt_spid=$(cat "$VIGIL_FLOW_SUPERVISOR_PIDFILE" 2>/dev/null) || _dt_spid=''
    [ -n "$_dt_spid" ] && kill -TERM "$_dt_spid" 2>/dev/null || true
  fi
  if [ -n "${TEST_TMP:-}" ]; then
    pkill -KILL -f "$TEST_TMP/bin/softflowd" 2>/dev/null || true
  fi
  rm -rf "${TEST_TMP:-/nonexistent}"
}

write_fixture_config() {
  # The spec's example config, pointed at the per-test sandbox.
  cat > "${VIGIL_FLOW_CONFIG:?}" <<CONF
# vigil-flow sensor configuration (bats fixture)
capture_interfaces = "lan0"
collector_host = "192.0.2.10"
collector_port = "2550"
netflow_version = "9"
active_timeout = "300"
inactive_timeout = "30"
max_flows = "8192"
status_file = "$VIGIL_FLOW_STATUS_FILE"
CONF
}

json_field() {
  # Prints the raw JSON token of a top-level scalar field from the health
  # file (the writer emits exactly two-space indentation, one field per
  # line — the tests assert against that contract too).
  [ -f "$VIGIL_FLOW_STATUS_FILE" ] || return 1
  grep -E "^  \"$1\":" "$VIGIL_FLOW_STATUS_FILE" |
    head -n1 |
    sed 's/^  "[^"]*": //; s/,$//'
}

json_string_value() {
  json_field "$1" | sed 's/^"//; s/"$//'
}

wait_for_health_match() {
  # Polls until the health file matches an extended grep pattern.
  # $1 = pattern, $2 = iteration budget (default 100 = 10s at 0.1s).
  _wm_budget=${2:-100}
  _wm_i=0
  while [ "$_wm_i" -lt "$_wm_budget" ]; do
    if [ -f "$VIGIL_FLOW_STATUS_FILE" ] && grep -Eq "$1" "$VIGIL_FLOW_STATUS_FILE"; then
      return 0
    fi
    sleep 0.1
    _wm_i=$((_wm_i + 1))
  done
  return 1
}
