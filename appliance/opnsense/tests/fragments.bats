#!/usr/bin/env bats
# Fragment-contract tests over the shipped reference files: the devfs ruleset
# id and bpf grant, the non-VNET jail keys, and the exact sensor config keys
# must hold in the repo files — the same contract install.sh emits.

REPO_ROOT=$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)

@test "devfs fragment pins ruleset 5 with the bpf grant" {
  fragment=$REPO_ROOT/appliance/opnsense/jail/devfs.rules
  grep -Fq '[devfsrules_vigil_flow=5]' "$fragment"
  grep -Fq 'add include $devfsrules_jail' "$fragment"
  grep -Fq "add path 'bpf*' unhide" "$fragment"
}

@test "jail fragment carries the non-VNET contract keys" {
  fragment=$REPO_ROOT/appliance/opnsense/jail/vigil-flow.conf
  grep -Fq 'devfs_ruleset = 5;' "$fragment"
  grep -Fq 'mount.devfs;' "$fragment"
  grep -Fq 'persist;' "$fragment"
  grep -Fq 'path = ' "$fragment"
  grep -Fq 'ip4.addr' "$fragment"
  grep -Fq 'exec.start' "$fragment"
  grep -Fq 'exec.stop' "$fragment"
}

@test "config template carries the exact spec keys" {
  template=$REPO_ROOT/appliance/opnsense/share/vigil-flow.conf
  for key in capture_interfaces collector_host collector_port netflow_version active_timeout inactive_timeout max_flows status_file; do
    grep -Fq "$key" "$template"
  done
}

@test "host wrapper only forwards status and reconfigure" {
  wrapper=$REPO_ROOT/appliance/opnsense/share/vigil-flow-jail-ctl.sh
  grep -Fq 'status | reconfigure' "$wrapper"
  grep -Fq 'exec jexec' "$wrapper"
}
