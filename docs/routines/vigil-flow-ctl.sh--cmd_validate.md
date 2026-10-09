# `cmd_validate` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. runs the validation gate without starting anything.

```sh
cmd_validate() {
  if ! run_validation_gate; then
    err "$VALIDATE_ERROR"
    return 1
  fi
  printf 'vigil-flow: configuration valid\n'
  printf '  capture_interfaces = %s\n' "$CFG_CAPTURE_INTERFACES"
  printf '  collector          = %s:%s\n' "$CFG_COLLECTOR_HOST" "$CFG_COLLECTOR_PORT"
  printf '  export_version     = %s\n' "$CFG_NF_VERSION"
  printf '  status_file        = %s\n' "$CFG_STATUS_FILE"
  # Advisory only (spec): an unresolvable or firewalled collector must
  # never block capture from starting — export problems surface in the
  # statistics polling and a stale last_stats_poll.
  collector_is_resolvable ||
    err "note: collector host '$CFG_COLLECTOR_HOST' does not resolve right now (advisory only; export failures surface in statistics)"
  return 0
}
```

## Purpose

The `validate` command. Reuses the supervisor's gate (sourced, one implementation). A failure prints the named cause and exits 1; success prints the resolved capture interfaces, collector, export version, and status file. An unresolvable collector host is advisory only (spec): the note is printed and the command still succeeds, because export problems surface in the statistics polling, not at startup.

## Inputs and outputs

- Output: `configuration valid` plus the four resolved values on success; the named cause on failure.
- Return status: 0 valid; 1 invalid.

## Side effects

None beyond output.

## Failure modes and exit codes

Exit 1 with the named cause when the gate rejects the configuration.

## Tests covering it

"validation gate accepts the fixture config end to end" drives the acceptance path; the validator suite's rejection cases cover the failure causes.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the pre-flight check for a config edit
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — collector resolvability is advisory
