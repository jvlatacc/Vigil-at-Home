#!/usr/bin/env bats
# State-machine contract: BOOT → VALIDATE → RUNNING → RESTARTING → DEGRADED
# with a health file that always tells the truth (component spec, "The
# supervisor"). The softflowd/softflowctl binaries are stubs; the suite is
# hermetic — no network, no real capture.

load helpers

setup() {
  daemon_setup
}

teardown() {
  daemon_teardown
}

@test "ctl start reaches RUNNING and the stub records the exact spec argv" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  # The spec's exact argv, as recorded by the stub softflowd.
  [ -f "$TEST_TMP/softflowd-argv" ]
  [ "$(cat "$TEST_TMP/softflowd-argv")" = "$(printf '%s\n' \
    -d -i lan0 \
    -n '192.0.2.10:2550' \
    -v 9 \
    -t active=300 -t inactive=30 \
    -m 8192 \
    -p "$RUN_DIR/vigil-flow-softflowd.pid.lan0" \
    -c "$RUN_DIR/vigil-flow-softflowd.ctl.lan0")" ]
  # Health JSON tells the truth about the running sensor.
  [ "$(json_string_value state)" = "RUNNING" ]
  [ "$(json_string_value collector)" = "192.0.2.10:2550" ]
  [ "$(json_string_value export_version)" = "9" ]
  [ "$(json_field capture_interfaces)" = '["lan0"]' ]
  [ "$(json_string_value degraded_cause)" = "" ]
  [ "$(json_field softflowd_pid)" -gt 0 ]
  wait_for_health_match '"flows_total": 49'
}

@test "health output is valid JSON" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  if command -v python3 >/dev/null 2>&1; then
    python3 -m json.tool "$VIGIL_FLOW_STATUS_FILE" >/dev/null
  else
    skip "python3 unavailable for JSON validation"
  fi
}

@test "an unreachable collector never blocks startup (stats-poll concern)" {
  export VIGIL_FLOW_TEST_CTL_FAIL=1
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  [ "$(json_string_value state)" = "RUNNING" ]
  # No successful poll ever happened: the timestamp stays null while the
  # sensor keeps capturing.
  [ "$(json_field last_stats_poll)" = "null" ]
  [ "$(json_field flows_total)" = "0" ]
}

@test "a dead child is restarted, counted, and health returns to RUNNING" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  old_pid=$(json_field softflowd_pid)
  kill -KILL "$old_pid"
  # Death is observable as RESTARTING; the failure counter is read there
  # because recovery resets the streak once the child is alive again.
  wait_for_health_match '"state": "RESTARTING"'
  [ "$(json_field consecutive_restart_failures)" = "1" ]
  wait_for_health_match '"state": "RUNNING"'
  new_pid=$(json_field softflowd_pid)
  [ "$new_pid" != "$old_pid" ]
}

@test "restart bound exhaustion degrades with a named cause" {
  export VIGIL_FLOW_MAX_CONSEC_RESTARTS=1
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  old_pid=$(json_field softflowd_pid)
  kill -KILL "$old_pid"
  # First death: attempt 1 <= bound 1 -> RESTARTING, then RUNNING with a
  # new pid (wait for RESTARTING so the stale RUNNING record cannot be
  # mistaken for the recovery).
  wait_for_health_match '"state": "RESTARTING"'
  wait_for_health_match '"state": "RUNNING"'
  second_pid=$(json_field softflowd_pid)
  [ "$second_pid" != "$old_pid" ]
  kill -KILL "$second_pid"
  # Second death: attempt 2 > bound 1 -> DEGRADED with the named cause.
  wait_for_health_match '"state": "DEGRADED"'
  [[ "$(json_string_value degraded_cause)" == restart_exhausted:* ]]
}

@test "losing the bpf grant degrades with bpf_missing and recovery is automatic" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  # Simulate the post-firmware-upgrade devfs wipe (the spec's headline
  # failure): no openable bpf device -> the sensor must say exactly that.
  rm -rf "$VIGIL_FLOW_BPF_DIR"
  wait_for_health_match '"state": "DEGRADED"'
  [[ "$(json_string_value degraded_cause)" == bpf_missing:* ]]
  # Restoring the grant resumes supervision with no operator restart.
  mkdir -p "$VIGIL_FLOW_BPF_DIR"
  : > "$VIGIL_FLOW_BPF_DIR/bpf0"
  wait_for_health_match '"state": "RUNNING"'
  [ "$(json_string_value degraded_cause)" = "" ]
}

@test "a vanished softflowd binary degrades with softflowd_missing" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  mv "$VIGIL_FLOW_SOFTFLOWD" "$VIGIL_FLOW_SOFTFLOWD.gone"
  wait_for_health_match '"state": "DEGRADED"'
  [[ "$(json_string_value degraded_cause)" == softflowd_missing:* ]]
}

@test "ctl stop leaves STOPPED, no supervisor, and no children" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  run "$CTL" stop
  [ "$status" -eq 0 ]
  [ "$(json_string_value state)" = "STOPPED" ]
  [ "$(json_field softflowd_pid)" = "null" ]
  [ ! -f "$VIGIL_FLOW_SUPERVISOR_PIDFILE" ]
  # Idempotent: a second stop still succeeds.
  run "$CTL" stop
  [ "$status" -eq 0 ]
}

@test "ctl start with an invalid config fails and writes DEGRADED health" {
  sed -i 's/^collector_port = .*/collector_port = "70000"/' "$VIGIL_FLOW_CONFIG"
  run "$CTL" start
  [ "$status" -ne 0 ]
  [ "$(json_string_value state)" = "DEGRADED" ]
  [[ "$(json_string_value degraded_cause)" == config_invalid:* ]]
}

@test "ctl status fails before the first start and reports afterward" {
  run "$CTL" status
  [ "$status" -eq 1 ]
  run "$CTL" start
  [ "$status" -eq 0 ]
  run "$CTL" status
  [ "$status" -eq 0 ]
  [[ "$output" == *'"state": "RUNNING"'* ]]
}

@test "ctl reconfigure applies a changed interface list" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  sed -i 's/^capture_interfaces = .*/capture_interfaces = "lan0,wan0"/' "$VIGIL_FLOW_CONFIG"
  run "$CTL" reconfigure
  [ "$status" -eq 0 ]
  wait_for_health_match '"capture_interfaces": \["lan0", "wan0"\]'
  [ "$(json_string_value state)" = "RUNNING" ]
  # Two children, one per interface, both tracked in the pid map.
  [[ "$(json_field softflowd_pids)" == *'"lan0": '* ]]
  [[ "$(json_field softflowd_pids)" == *'"wan0": '* ]]
}

@test "ctl start is idempotent while the sensor is running" {
  run "$CTL" start
  [ "$status" -eq 0 ]
  first_pid=$(json_field softflowd_pid)
  run "$CTL" start
  [ "$status" -eq 0 ]
  wait_for_health_match '"state": "RUNNING"'
  [ "$(json_field softflowd_pid)" = "$first_pid" ]
}
