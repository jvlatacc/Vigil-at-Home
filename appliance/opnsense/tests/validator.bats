#!/usr/bin/env bats
# Validator contract: every rejection the spec lists, each with a named
# cause; plus the spec's guarantee that collector resolvability never
# blocks validation.
#
# The gate communicates through VALIDATE_ERROR rather than stdout, and the
# functions mutate state, so the tests call them directly — bats `run`
# would fork a subshell and lose the variable. Bats tests execute under
# `set -e`, so every call expected to fail uses the `cmd || rc=$?` guard.

load helpers

setup() {
  daemon_setup
}

teardown() {
  daemon_teardown
}

replace_config_value() { # $1 key, $2 new value
  sed -i "s|^$1 = .*|$1 = \"$2\"|" "$VIGIL_FLOW_CONFIG"
}

delete_config_line() { # $1 key
  sed -i "/^$1 = /d" "$VIGIL_FLOW_CONFIG"
}

@test "validation gate accepts the fixture config end to end" {
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -eq 0 ]
  [ -z "$VALIDATE_ERROR" ]
}

@test "validation rejects a collector port above 65535" {
  replace_config_value collector_port 70000
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"collector_port '70000' is outside 1-65535"* ]]
}

@test "validation rejects a collector port of zero" {
  replace_config_value collector_port 0
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"outside 1-65535"* ]]
}

@test "validation rejects a non-numeric collector port" {
  replace_config_value collector_port twenty-five
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"outside 1-65535"* ]]
}

@test "validation rejects an unknown export version" {
  replace_config_value netflow_version 8
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"netflow_version '8' must be 9 or ipfix"* ]]
}

@test "validation rejects an empty capture interface list" {
  replace_config_value capture_interfaces ''
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"capture_interfaces '': every entry must be a non-empty name"* ]]
}

@test "validation rejects an out-of-range active timeout" {
  replace_config_value active_timeout 0
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"active_timeout '0' must be an integer of 1-604800 seconds"* ]]
}

@test "validation rejects a max_flows of zero" {
  replace_config_value max_flows 0
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"max_flows '0' must be an integer of 1-1048576"* ]]
}

@test "validation rejects a relative status_file path" {
  replace_config_value status_file var/db/vigil-flow/status.json
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"must be an absolute path"* ]]
}

@test "validation rejects an unknown configuration key" {
  printf 'and_now_for_something = "completely different"\n' >> "$VIGIL_FLOW_CONFIG"
  rc=0
  load_config || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"unknown key 'and_now_for_something'"* ]]
}

@test "validation rejects a duplicate configuration key" {
  printf 'collector_port = "9999"\n' >> "$VIGIL_FLOW_CONFIG"
  rc=0
  load_config || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"duplicate"* ]]
}

@test "validation rejects a line outside the key = value grammar" {
  printf 'this line has no equals sign\n' >> "$VIGIL_FLOW_CONFIG"
  rc=0
  load_config || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"has no '=' separator"* ]]
}

@test "validation rejects a key that is not a bare identifier" {
  printf 'capture;interfaces = "lan0"\n' >> "$VIGIL_FLOW_CONFIG"
  rc=0
  load_config || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"not a bare identifier"* ]]
}

@test "validation rejects an unquoted value (the grammar requires quotes)" {
  sed -i 's/^collector_host = "192.0.2.10"/collector_host = 192.0.2.10/' "$VIGIL_FLOW_CONFIG"
  rc=0
  load_config || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"must be a double-quoted value"* ]]
}

@test "validation rejects a config missing a required key" {
  delete_config_line collector_host
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"required key"* ]]
  [[ "$VALIDATE_ERROR" == *"collector_host"* ]]
}

@test "validation reports a missing config file with a named cause" {
  rm -f "$VIGIL_FLOW_CONFIG"
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"config_missing:"* ]]
}

@test "validation rejects a configured interface that does not exist" {
  replace_config_value capture_interfaces 'lan0,notglyph0'
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"interface_missing: capture interface 'notglyph0'"* ]]
}

@test "validation names the lost bpf grant when no bpf device is openable" {
  rm -rf "$VIGIL_FLOW_BPF_DIR"
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -ne 0 ]
  [[ "$VALIDATE_ERROR" == *"bpf_missing:"* ]]
  [[ "$VALIDATE_ERROR" == *"devfsrules_vigil_flow"* ]]
}

@test "comments and blank lines are ignored" {
  printf '\n# a comment line\n\n' >> "$VIGIL_FLOW_CONFIG"
  rc=0
  run_validation_gate || rc=$?
  [ "$rc" -eq 0 ]
}
