#!/bin/sh
# vigil-flow uninstaller — removes exactly what install.sh recorded in its
# manifest: the jail, the devfs fragment, the jail.conf include, the configd
# actions, the host wrapper, and the jail userland tree. POSIX sh; run as
# root on the OPNsense host.
#
# Testing contract: when VIGIL_FLOW_SKIP_MAIN is set, sourcing this file only
# defines functions.

VIGIL_ROOT=${VIGIL_ROOT:-/var/vigil-flow}
MANIFEST_FILE=${MANIFEST_FILE:-$VIGIL_ROOT/install-manifest.txt}
JAIL_NAME=vigil-flow

err() {
  printf '%s: %s\n' "${0##*/}" "$1" >&2
}

die() {
  err "$1"
  exit 1
}

usage() {
  cat <<EOF
usage: uninstall.sh

Removes the $JAIL_NAME jail, devfs fragment, jail.conf include, configd
actions, host wrapper, and jail userland recorded in $MANIFEST_FILE.
Run as root.
EOF
}

stop_jail() {
  # A jail that is not running is the normal idempotent case here, not an
  # error — the deliberate || true only swallows that expected state.
  jail -r "$JAIL_NAME" >/dev/null 2>&1 || true
}

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

if [ "${VIGIL_FLOW_SKIP_MAIN:-0}" = "1" ]; then
  : # sourced for hermetic testing — define functions only
else
  main "$@"
fi
