# `write_manifest` — install.sh

**Script:** `appliance/opnsense/install.sh`. Records everything the installer
creates, so uninstall.sh removes exactly that.

```sh
write_manifest() {
  # Records everything the installer creates so uninstall.sh removes exactly
  # that. Written before the first host modification.
  cat > "$MANIFEST_FILE" <<EOF
# vigil-flow install manifest — consumed by appliance/opnsense/uninstall.sh
appended:$DEVFS_RULES_FILE
appended:$JAIL_CONF_INCLUDE_FILE
file:$JAIL_CONF_DIR/vigil-flow.conf
file:$ACTION_DIR/actions_vigil-flow.conf
file:$HOST_WRAPPER
file:$JAIL_ROOT/etc/vigil-flow.conf
tree:$JAIL_ROOT
EOF
}
```

## Purpose

Give the uninstaller a complete, typed inventory: which files got whole-file
writes (`file:`), which got appended fragments (`appended:`), and which tree
was created from scratch (`tree:`). Written before the first host modification
so an install that dies partway still leaves a truthful inventory behind.

## Inputs and outputs

- Inputs: the location variables (`DEVFS_RULES_FILE`,
  `JAIL_CONF_INCLUDE_FILE`, `JAIL_CONF_DIR`, `ACTION_DIR`, `HOST_WRAPPER`,
  `JAIL_ROOT`).
- Output: `$MANIFEST_FILE` (default `/var/vigil-flow/install-manifest.txt`).
- Return status: 0 on success; on write failure `main` wraps it with
  `write_manifest || die "cannot write $MANIFEST_FILE"`.

## Side effects

Creates or overwrites the manifest file. The `mkdir -p "$VIGIL_ROOT"` in
`main` precedes it.

## Failure modes and exit codes

Exit 1 via the caller's `die` when the manifest cannot be written; no
provisioning step has run by then, so nothing is left behind.

## Tests covering it

No direct bats case (the bats suite repoints `MANIFEST_FILE` at a temp dir but
does not exercise this function). The manifest contract — entries consumed by
`process_manifest` — is verified on device by running install then uninstall.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
  (the host gains only what the manifest records)
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the devfs grant entry is part of this inventory)
