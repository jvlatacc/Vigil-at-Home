# `copy_host_wrapper` — install.sh

**Script:** `appliance/opnsense/install.sh`. Installs the host-side jexec
wrapper from the repo copy.

```sh
copy_host_wrapper() {
  # The wrapper ships as a repo file (share/vigil-flow-jail-ctl.sh) so lint
  # coverage includes it like every other shell file — the installer copies
  # it into place.
  _wrapper_src=$SCRIPT_DIR/share/vigil-flow-jail-ctl.sh
  [ -f "$_wrapper_src" ] ||
    die "host wrapper source not found at $_wrapper_src: copy the whole appliance/opnsense directory onto the host"
  mkdir -p "$(dirname "$HOST_WRAPPER")" || die "cannot create $(dirname "$HOST_WRAPPER")"
  cp "$_wrapper_src" "$HOST_WRAPPER" || die "cannot install $HOST_WRAPPER"
  chmod 0755 "$HOST_WRAPPER" || die "cannot chmod $HOST_WRAPPER"
}
```

## Purpose

Put the configd actions' command in place at `/usr/local/bin/vigil-flow-jail-ctl.sh`
with mode 0755. The wrapper ships as a repo file rather than a heredoc so
shellcheck covers it like every other shell file (the code comment quoted
above).

## Inputs and outputs

- Inputs: `$SCRIPT_DIR` (the installer's own directory), `HOST_WRAPPER`
  (default `/usr/local/bin/vigil-flow-jail-ctl.sh`).
- Output: none.
- Return status: fatal on every failure (`die`, exit 1).

## Side effects

Creates the target directory, copies the wrapper, sets mode 0755. The copied
file is a `file:` entry in the manifest.

## Failure modes and exit codes

Dies with a named cause when the source file is missing (the message tells the
operator to copy the whole `appliance/opnsense` directory onto the host), when
the target directory cannot be created, when the copy fails, or when the chmod
fails.

## Tests covering it

No direct bats case (the source file's contract — forwarding only `status`
and `reconfigure` via `exec jexec` — is covered by "host wrapper only forwards
status and reconfigure" in `appliance/opnsense/tests/fragments.bats`).

## Linked decisions

- [0005 — No PHP GUI in v1: configd actions plus the ctl surface](../decisions/0005-no-php-gui-configd-actions.md)
- [0004 — POSIX sh runtime, shellcheck + bats CI](../decisions/0004-posix-sh-runtime-shell-ci.md)
  (why the wrapper ships as a repo file)
