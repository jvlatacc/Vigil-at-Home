# `cmd_status` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. prints the sensor's health JSON.

```sh
cmd_status() {
  # Status must work even when the configuration is broken — fall back to
  # the default status file location, which is what the spec's dashboard
  # readers poll.
  load_config >/dev/null 2>&1 || true
  if [ -r "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
    return 0
  fi
  err "no status file at $STATUS_FILE: the sensor has never started"
  return 1
}
```

## Purpose

The `status` command. The configuration is loaded best-effort so a broken config degrades to the default status-file location instead of hiding the sensor's last words. A readable health file is printed as-is and the command exits 0 — a DEGRADED sensor still prints its (truthful) JSON. No status file means the sensor has never started: exit 1 with that named on stderr.

## Inputs and outputs

- Output: the health JSON on stdout when available.
- Return status: 0 status printed; 1 no status file.

## Side effects

None beyond stdout/stderr.

## Failure modes and exit codes

Exit 1 only when no status file exists.

## Tests covering it

"ctl status fails before the first start and reports afterward" (fails before the first start, reports afterward), "health output is valid JSON" (the printed file is valid JSON).

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the operator's query command
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md) — the collector and export fields describe the configured pipeline
