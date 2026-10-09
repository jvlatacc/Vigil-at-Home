# `main` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Orchestrates the removal.

```sh
main() {
  set -eu

  [ "$(id -u)" -eq 0 ] || die "this uninstaller must run as root"
  [ -n "$VIGIL_ROOT" ] || die "VIGIL_ROOT resolves to an empty string: refusing to operate"
  [ -f "$MANIFEST_FILE" ] ||
    die "no install manifest at $MANIFEST_FILE: nothing recorded to remove (was install.sh run?)"

  stop_jail
  process_manifest
  rm -rf "$VIGIL_ROOT"

  printf '%s: removed %s and everything recorded in its manifest\n' "${0##*/}" "$JAIL_NAME"
}
```

## Purpose

Run the removal in a safe order: verify preconditions (root, a non-empty
`VIGIL_ROOT`, an existing manifest), stop the jail, apply the manifest, then
remove the now-empty `$VIGIL_ROOT`. Refuses to operate without a manifest —
the uninstaller removes only what the installer recorded.

## Inputs and outputs

- Input: none (uses the `VIGIL_ROOT`/`MANIFEST_FILE` location variables and
  the manifest file).
- Output: the completion line on stdout.
- Return status: 0 on success; 1 via `die` on any failed precondition.

## Side effects

Stops the running jail, deletes every file and tree in the manifest, and
finally `rm -rf "$VIGIL_ROOT"` (the jail tree and the manifest itself).

## Failure modes and exit codes

Exit 1 with a named cause for: non-root, `VIGIL_ROOT` resolving empty
(refusing to operate), or a missing manifest ("was install.sh run?"). No
removal happens in any of those cases.

## Tests covering it

None directly — the bats suite skips `main` via `VIGIL_FLOW_SKIP_MAIN=1`;
the uninstall path is on-device verified (runbook: install, verify, uninstall,
re-install).

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
  (removes exactly the recorded inventory)
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the bpf grant and jail tree are among the removed items)
