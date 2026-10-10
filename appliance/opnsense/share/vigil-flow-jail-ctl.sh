#!/bin/sh
# vigil-flow host wrapper — thin jexec bridge used by the configd actions so
# operators get `configctl vigil-flow status|reconfigure` without touching
# jail mechanics. Installed to /usr/local/bin by appliance/opnsense/install.sh.
set -eu
JAIL_NAME=vigil-flow

case ${1:-} in
  status | reconfigure) ;;
  *)
    printf 'usage: %s status|reconfigure\n' "${0##*/}" >&2
    exit 2
    ;;
esac

exec jexec "$JAIL_NAME" /usr/local/bin/vigil-flow-ctl.sh "$1"
