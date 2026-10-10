# `strip_marked_block` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Deletes a marked vigil-flow
fragment block from a host file.

```sh
strip_marked_block() {
  # $1 = file carrying a "# >>> vigil-flow ..." block. Deletes the marked
  # lines (and only those) portably across BSD and GNU userland.
  [ -f "$1" ] || return 0
  grep -q '^# >>> vigil-flow' "$1" || return 0
  awk '
    /^# >>> vigil-flow/ { skip = 1; next }
    /^# <<< vigil-flow/ { skip = 0; next }
    skip == 0 { print }
  ' "$1" > "$1.uninstall.tmp" && mv "$1.uninstall.tmp" "$1"
}
```

## Purpose

Undo what `append_devfs_fragment` and `ensure_jail_conf_include` appended:
remove exactly the lines between the `# >>> vigil-flow` and `# <<< vigil-flow`
markers (the same marker style covers both the devfs and the jailconf blocks —
the start pattern is a prefix of both) and leave every other line untouched.

## Inputs and outputs

- Input: `$1` — the file carrying a marked block.
- Output: none.
- Return status: 0 in all normal paths (including both no-op cases); non-zero
  only if the awk rewrite or `mv` fails.

## Side effects

Rewrites the file via a `.uninstall.tmp` sibling plus `mv` (atomic-ish
replace, portable across BSD and GNU userland per the comment). Callers
(`process_manifest`'s `appended:` branch) then delete the file outright if it
is left empty.

## Failure modes and exit codes

No-ops on a missing file or a file without the start marker. A failed rewrite
propagates awk/mv's status; under `set -eu` in `main` that aborts the
uninstall with the error on stderr.

## Tests covering it

No direct bats case in this branch's suite; the inverse contract (the
installer's markers are present and exactly once) is asserted in
`appliance/opnsense/tests/installer.bats` ("append_devfs_fragment is
idempotent and grants bpf", "ensure_jail_conf_include adds exactly one
include directive"). The strip path is verified on device by install →
uninstall → re-install.

## Linked decisions

- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the marked devfs grant block this removes)
