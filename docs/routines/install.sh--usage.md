# `usage` — install.sh

**Script:** `appliance/opnsense/install.sh`. Prints the installer's help text.

```sh
usage() {
  cat <<EOF
usage: install.sh --interfaces IFACE[,IFACE...] --collector HOST[:PORT] --ip ADDRESS [--version 9|ipfix]
...
EOF
}
```

## Purpose

Show the operator the four provisioning flags, their meaning, and the default
collector port. The text interpolates `$JAIL_NAME` and
`$DEFAULT_COLLECTOR_PORT`, so the help always matches the product defaults
(port 2550).

## Inputs and outputs

- Input: none (reads `$DEFAULT_COLLECTOR_PORT` for the default-port line).
- Output: the usage heredoc on stdout.
- Return status: 0.

## Side effects

None.

## Failure modes and exit codes

None. `parse_args` calls `usage` and then `exit 0` on `-h`/`--help`. Unknown or
missing flags print named errors instead of the help text and return 1.

## Tests covering it

No direct bats case; the flag surface it documents is covered by the eleven
`parse_args` cases in `appliance/opnsense/tests/installer.bats`.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md)
  (the installer flags are part of the v1 operator surface)
- [0002 — NetFlow v9 over UDP, collector port 2550](../decisions/0002-netflow-v9-udp-port-2550.md)
  (the default port shown in the help)
