# `process_manifest` — uninstall.sh

**Script:** `appliance/opnsense/uninstall.sh`. Applies every entry in the
install manifest.

```sh
process_manifest() {
  # Applies each manifest entry: appended: -> strip the marked block,
  # file: -> delete, tree: -> recursive delete. An unrecognized line is
  # reported and skipped, never silently ignored.
  while IFS= read -r _line; do
    case $_line in
      '' | \#*) continue ;;
      appended:*)
        _path=${_line#appended:}
        strip_marked_block "$_path"
        # A file we created from scratch is now empty: remove it. A file
        # with prior content keeps that content.
        if [ -f "$_path" ] && [ ! -s "$_path" ]; then
          rm -f "$_path"
        fi
        ;;
      file:*) rm -f "${_line#file:}" ;;
      tree:*) rm -rf "${_line#tree:}" ;;
      *) err "unrecognized manifest line skipped: $_line" ;;
    esac
  done < "$MANIFEST_FILE"
}
```

## Purpose

The uninstaller's engine: walk the manifest `write_manifest` recorded and
remove exactly that — stripping marked fragments from files the host already
had, deleting files the install created, and recursively deleting the jail
tree.

## Inputs and outputs

- Input: `$MANIFEST_FILE` (default `/var/vigil-flow/install-manifest.txt`),
  read line by line.
- Output: none of its own; an `err` line per unrecognized entry.
- Return status: 0 after processing; under `set -eu` a failing command inside
  the loop aborts the script.

## Side effects

Deletes files and trees named by the manifest (`file:`, `tree:`), strips
marked blocks (`appended:`, via `strip_marked_block`), and removes an
`appended:` file that is left empty — the comment explains the distinction: a
file the install created from scratch goes away entirely; a file with prior
content keeps what remains.

## Failure modes and exit codes

An unrecognized line is reported ("unrecognized manifest line skipped") and
skipped, never silently ignored — the err/return contract keeps a corrupted
manifest visible. A missing manifest never reaches this function; `main`
dies before calling it.

## Tests covering it

No direct bats case in this branch's suite (the manifest lifecycle needs a
filesystem fixture and is covered on device by install → uninstall →
re-install). The manifest line formats it consumes are exactly those
`write_manifest` emits.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
  (clean removal of the recorded inventory)
- [0001 — Capture runs entirely inside the jail](../decisions/0001-jail-contained-capture-non-vnet-bpf.md)
  (the devfs grant is stripped with the rest)
