# `usage` — vigil-flow-supervisor.sh

**Script:** `appliance/opnsense/share/vigil-flow-supervisor.sh`. prints the supervisor's invocation help.

```sh
usage() {
  cat <<EOF
usage: ${0##*/} [--config-file PATH] run

Runs the vigil-flow sensor supervisor until terminated. Started by
vigil-flow-ctl.sh start (the jail's exec.start); not normally invoked by
hand. Terminated gracefully with SIGTERM, which stops the softflowd
children after a final flow export attempt.
EOF
}
```

## Purpose

Documents the one supported invocation (`[--config-file PATH] run`) and the operating contract: started by `vigil-flow-ctl.sh start`, terminated gracefully with SIGTERM.

## Inputs and outputs

- Output: the usage heredoc on stdout.

## Side effects

None.

## Failure modes and exit codes

Cannot fail.

## Tests covering it

No direct bats case; on device, `vigil-flow-supervisor.sh --help` prints it.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md) — the ctl script is the operator surface; the supervisor's own help describes its role
