# `usage` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Prints the uninstaller's help
text.

```sh
usage() {
  cat <<EOF
usage: uninstall.sh

Removes the $JAIL_NAME jail, devfs fragment, jail.conf include, configd
actions, host wrapper, and jail userland recorded in $MANIFEST_FILE.
Run as root.
EOF
}
```

## Purpose

Tell the operator what the uninstaller removes and where the inventory comes
from (the manifest). Takes no flags: the uninstaller has none.

## Inputs and outputs

- Input: none (interpolates `$JAIL_NAME` and `$MANIFEST_FILE`).
- Output: the usage heredoc on stdout.
- Return status: 0.

## Side effects

None.

## Failure modes and exit codes

None. Note: unlike the installer, this script's `main` does not parse flags —
passing arguments does not print usage; the extra arguments are simply unused
and the uninstall proceeds. Documented here so the difference is visible.

## Tests covering it

No direct bats case.

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md)
  (the uninstaller is part of the CLI operator surface)
