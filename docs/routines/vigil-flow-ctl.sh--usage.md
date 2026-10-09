# `usage` — vigil-flow-ctl.sh

**Script:** `appliance/opnsense/share/vigil-flow-ctl.sh`. prints the operator CLI's commands and exit-code contract.

```sh
usage() {
  cat <<EOF
usage: ${0##*/} [--config-file PATH] start|stop|status|validate|reconfigure

Operates the vigil-flow sensor inside the jail.

  start        Validate the configuration, then run the supervisor in the
               background. A failed validation writes the DEGRADED health
               record and exits 1 — the health file always tells the truth.
  stop         Stop the supervisor gracefully (final flow export attempt),
               sweep any orphaned softflowd, and leave a STOPPED record.
  status       Print the health JSON. Exits 1 only when no status file
               exists; a DEGRADED sensor still prints its (truthful) JSON.
  validate     Run the full validation gate and print the result. A
               collector that does not resolve is advisory only (spec) and
               never fails validation.
  reconfigure  Validate the current configuration and restart the sensor
               with it.

  --config-file PATH   Read the sensor configuration from PATH (default
                       /etc/vigil-flow.conf, as installed).
EOF
}
```

## Purpose

Documents `start`, `stop`, `status`, `validate`, `reconfigure`, the `--config-file PATH` override, and the exit-code semantics (0 success, 1 failed operation, 2 usage error).

## Inputs and outputs

- Output: the usage heredoc on stdout.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

No direct bats case; on device, `vigil-flow-ctl.sh --help` prints it.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — this help is the v1 operator surface's contract
