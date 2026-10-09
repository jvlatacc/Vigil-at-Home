#!/usr/bin/env bats
# Hermetic contract tests for the vigil-flow installer: flag parsing,
# validation rejections, ABI mapping, and idempotent fragment handling.
# No network, no host modification — effectful functions are pointed at a
# temporary sandbox through the overridable location variables.

setup() {
  TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/vigil-flow-install.XXXXXX")
  # shellcheck source=../install.sh
  VIGIL_FLOW_SKIP_MAIN=1 . "$BATS_TEST_DIRNAME/../install.sh"
}

teardown() {
  rm -rf "$TEST_TMP"
}

@test "parse_args accepts required flags and applies the defaults" {
  parse_args --interfaces lan0 --collector 192.0.2.10 --ip 192.0.2.254
  [ "$INTERFACES" = "lan0" ]
  [ "$COLLECTOR_HOST" = "192.0.2.10" ]
  [ "$COLLECTOR_PORT" = "2550" ]
  [ "$JAIL_IP" = "192.0.2.254" ]
  [ "$NF_VERSION" = "9" ]
}

@test "parse_args accepts ipfix, an explicit port, and multiple interfaces" {
  parse_args --interfaces lan0,wan0 --collector 192.0.2.10:9999 --ip 192.0.2.254 --version ipfix
  [ "$INTERFACES" = "lan0,wan0" ]
  [ "$COLLECTOR_HOST" = "192.0.2.10" ]
  [ "$COLLECTOR_PORT" = "9999" ]
  [ "$NF_VERSION" = "ipfix" ]
}

@test "parse_args rejects a collector with an out-of-range port" {
  run parse_args --interfaces lan0 --collector 192.0.2.10:70000 --ip 192.0.2.254
  [ "$status" -ne 0 ]
  [[ "$output" == *"outside 1-65535"* ]]
}

@test "parse_args rejects a collector port of zero" {
  run parse_args --interfaces lan0 --collector 192.0.2.10:0 --ip 192.0.2.254
  [ "$status" -ne 0 ]
  [[ "$output" == *"outside 1-65535"* ]]
}

@test "parse_args rejects a collector with an empty host" {
  run parse_args --interfaces lan0 --collector :2550 --ip 192.0.2.254
  [ "$status" -ne 0 ]
  [[ "$output" == *"host part is empty"* ]]
}

@test "parse_args rejects a missing --ip" {
  run parse_args --interfaces lan0 --collector 192.0.2.10:2550
  [ "$status" -ne 0 ]
  [[ "$output" == *"missing required --ip"* ]]
}

@test "parse_args rejects a non-IPv4 --ip" {
  run parse_args --interfaces lan0 --collector 192.0.2.10:2550 --ip 999.999.999.999
  [ "$status" -ne 0 ]
  [[ "$output" == *"not a valid IPv4 address"* ]]
}

@test "parse_args rejects an unknown --version" {
  run parse_args --interfaces lan0 --collector 192.0.2.10:2550 --ip 192.0.2.254 --version 5
  [ "$status" -ne 0 ]
  [[ "$output" == *"must be 9 or ipfix"* ]]
}

@test "parse_args rejects an unknown option" {
  run parse_args --interfaces lan0 --collector 192.0.2.10 --ip 192.0.2.254 --bogus
  [ "$status" -ne 0 ]
  [[ "$output" == *"unknown option"* ]]
}

@test "parse_args rejects a flag missing its value" {
  run parse_args --interfaces
  [ "$status" -ne 0 ]
  [[ "$output" == *"requires a value"* ]]
}

@test "parse_args rejects an empty interface token" {
  run parse_args --interfaces "lan0,,wan0" --collector 192.0.2.10 --ip 192.0.2.254
  [ "$status" -ne 0 ]
}

@test "is_valid_ipv4 accepts only dotted quads with octets up to 255" {
  is_valid_ipv4 192.0.2.254
  run is_valid_ipv4 192.0.2.256
  [ "$status" -ne 0 ]
  run is_valid_ipv4 192.0.2
  [ "$status" -ne 0 ]
  run is_valid_ipv4 "not-an-ip"
  [ "$status" -ne 0 ]
}

@test "freebsd_release_from_userland maps patch levels and rejects non-release builds" {
  [ "$(freebsd_release_from_userland 14.2-RELEASE)" = "14.2-RELEASE" ]
  [ "$(freebsd_release_from_userland 14.2-RELEASE-p3)" = "14.2-RELEASE" ]
  run freebsd_release_from_userland 14.3-STABLE
  [ "$status" -ne 0 ]
}

@test "pkg_abi_for and base_txz_url build the official FreeBSD coordinates" {
  [ "$(pkg_abi_for 14.2-RELEASE amd64)" = "FreeBSD:14:amd64" ]
  [ "$(base_txz_url 14.2-RELEASE amd64)" = "https://download.freebsd.org/ftp/releases/amd64/14.2-RELEASE/base.txz" ]
}

@test "append_devfs_fragment is idempotent and grants bpf" {
  rules=$TEST_TMP/devfs.rules
  printf 'existing rules\n' > "$rules"
  append_devfs_fragment "$rules"
  append_devfs_fragment "$rules"
  count=$(grep -cF '[devfsrules_vigil_flow=5]' "$rules" || true)
  [ "$count" -eq 1 ]
  grep -Fq "add include \$devfsrules_jail" "$rules"
  grep -Fq "add path 'bpf*' unhide" "$rules"
}

@test "ensure_jail_conf_include adds exactly one include directive" {
  conf=$TEST_TMP/jail.conf
  printf '# existing jail config\n' > "$conf"
  ensure_jail_conf_include "$conf"
  ensure_jail_conf_include "$conf"
  count=$(grep -cF '.include "/etc/jail.conf.d/*.conf";' "$conf" || true)
  [ "$count" -eq 1 ]
}

@test "ensure_jail_conf_include skips when the include already exists" {
  conf=$TEST_TMP/jail.pre.conf
  printf '.include "/etc/jail.conf.d/*.conf";\n' > "$conf"
  ensure_jail_conf_include "$conf"
  ! grep -q 'vigil-flow-jailconf' "$conf"
}

@test "write_jail_conf emits the non-VNET contract with the --ip address" {
  JAIL_CONF_DIR=$TEST_TMP/jail.conf.d
  JAIL_ROOT=$TEST_TMP/var/vigil-flow/jail
  JAIL_IP=192.0.2.254
  write_jail_conf
  conf=$JAIL_CONF_DIR/vigil-flow.conf
  grep -Fq 'devfs_ruleset = 5;' "$conf"
  grep -Fq 'mount.devfs;' "$conf"
  grep -Fq 'persist;' "$conf"
  grep -Fq "ip4.addr = 192.0.2.254;" "$conf"
  grep -Fq 'exec.start = "/usr/local/bin/vigil-flow-ctl.sh start";' "$conf"
  grep -Fq 'exec.stop = "/usr/local/bin/vigil-flow-ctl.sh stop";' "$conf"
}

@test "write_sensor_config emits the exact spec keys from the flags" {
  JAIL_ROOT=$TEST_TMP/jail
  INTERFACES=lan0
  COLLECTOR_HOST=192.0.2.10
  COLLECTOR_PORT=2550
  NF_VERSION=9
  write_sensor_config
  conf=$JAIL_ROOT/etc/vigil-flow.conf
  grep -Fq 'capture_interfaces = "lan0"' "$conf"
  grep -Fq 'collector_host = "192.0.2.10"' "$conf"
  grep -Fq 'collector_port = "2550"' "$conf"
  grep -Fq 'netflow_version = "9"' "$conf"
  grep -Fq 'active_timeout = "300"' "$conf"
  grep -Fq 'inactive_timeout = "30"' "$conf"
  grep -Fq 'max_flows = "8192"' "$conf"
  grep -Fq 'status_file = "/var/db/vigil-flow/status.json"' "$conf"
}
