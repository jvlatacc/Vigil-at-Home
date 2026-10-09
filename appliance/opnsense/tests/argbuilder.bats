#!/usr/bin/env bats
# Arg-builder contract (component spec, "The supervisor"): a pure function
# that turns a validated config into the exact softflowd argv.

load helpers

setup() {
  daemon_setup
}

teardown() {
  daemon_teardown
}

expected_argv() { # $1 iface, $2 nf-version
  printf '%s\n' \
    -d -i "$1" \
    -n '192.0.2.10:2550' \
    -v "$2" \
    -t active=300 -t inactive=30 \
    -m 8192 \
    -p "$RUN_DIR/vigil-flow-softflowd.pid.$1" \
    -c "$RUN_DIR/vigil-flow-softflowd.ctl.$1"
}

@test "arg builder emits the exact spec argv for the v9 fixture" {
  load_config
  CAP_IFACE=lan0
  PIDFILE="$RUN_DIR/vigil-flow-softflowd.pid.lan0"
  CTLFILE="$RUN_DIR/vigil-flow-softflowd.ctl.lan0"
  run build_softflowd_args
  [ "$status" -eq 0 ]
  [ "$output" = "$(expected_argv lan0 9)" ]
}

@test "arg builder maps ipfix to softflowd -v 10" {
  sed -i 's/netflow_version = "9"/netflow_version = "ipfix"/' "$VIGIL_FLOW_CONFIG"
  load_config
  CAP_IFACE=wan0
  PIDFILE="$RUN_DIR/vigil-flow-softflowd.pid.wan0"
  CTLFILE="$RUN_DIR/vigil-flow-softflowd.ctl.wan0"
  run build_softflowd_args
  [ "$status" -eq 0 ]
  [ "$output" = "$(expected_argv wan0 10)" ]
}

@test "arg builder carries the configured timeout tunables" {
  sed -i 's/active_timeout = "300"/active_timeout = "60"/' "$VIGIL_FLOW_CONFIG"
  sed -i 's/inactive_timeout = "30"/inactive_timeout = "5"/' "$VIGIL_FLOW_CONFIG"
  load_config
  CAP_IFACE=lan0
  PIDFILE="$RUN_DIR/p"
  CTLFILE="$RUN_DIR/c"
  run build_softflowd_args
  [ "$status" -eq 0 ]
  [ "$output" = "$(printf '%s\n' -d -i lan0 -n '192.0.2.10:2550' -v 9 -t active=60 -t inactive=5 -m 8192 -p "$RUN_DIR/p" -c "$RUN_DIR/c")" ]
}

@test "arg builder refuses a missing capture interface" {
  load_config
  CAP_IFACE=''
  PIDFILE="$RUN_DIR/p"
  CTLFILE="$RUN_DIR/c"
  run build_softflowd_args
  [ "$status" -ne 0 ]
}

@test "arg builder refuses a missing collector host" {
  load_config
  CAP_IFACE=lan0
  CFG_COLLECTOR_HOST=''
  PIDFILE="$RUN_DIR/p"
  CTLFILE="$RUN_DIR/c"
  run build_softflowd_args
  [ "$status" -ne 0 ]
}

@test "arg builder refuses an unknown export version" {
  load_config
  CAP_IFACE=lan0
  CFG_NF_VERSION=7
  PIDFILE="$RUN_DIR/p"
  CTLFILE="$RUN_DIR/c"
  run build_softflowd_args
  [ "$status" -ne 0 ]
}
