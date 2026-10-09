#!/usr/bin/env bash
# validate-linux.sh — prove an installed Vigil at Home works on this Linux
# machine, one distro family at a time.
#
#   sudo bash scripts/validate-linux.sh              # validate this machine
#   bash scripts/validate-linux.sh --self-test       # verify the harness only
#
# Seven checks run in order — package install, helper service, helper socket,
# fapolicyd enforcing, a deny-by-hash roundtrip, osquery with an observed eBPF
# launch row, and uninstall cleanliness — each printing PASS, or FAIL plus a
# one-line remedy. Every FAIL exits nonzero: 0 passes clean, 1 fails one or
# more checks, 2 means the routine could not run here (not root, not Linux,
# or a distro family it does not know). See design/linux-validation-routines.md
# for why each check exists and what CI proves without it.
#
# The checks read the system; they change it in exactly one place: the
# deny-by-hash roundtrip adds its own fapolicyd rules file and restarts
# fapolicyd twice, restoring both through an EXIT trap. It never touches
# Vigil's own rules. --uninstall-roundtrip makes check 7 destructive for real
# (uninstall, assert, reinstall); without it the checks are read-only.
set -u
set -o pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=validate-linux/common.sh
source "$SCRIPT_DIR/validate-linux/common.sh"

OPT_SELF_TEST=''
OPT_ROUNDTRIP=''
OPT_FAMILY=''
OPT_OS_RELEASE=/etc/os-release
OPT_APPIMAGE=''
OPT_UNINSTALL_SCRIPT=''
OPT_OSQUERY_WAIT=''

usage() {
  cat <<'EOF'
validate-linux.sh — prove an installed Vigil at Home works on this Linux machine.

Usage:
  sudo bash scripts/validate-linux.sh [options]
  bash scripts/validate-linux.sh --self-test

Runs seven checks — package install, helper service active, helper socket
answers, fapolicyd enforcing, deny-by-hash roundtrip, osquery live with an
observed eBPF launch row, uninstall cleanliness — printing PASS, or FAIL plus
a one-line remedy, for each. Exit codes: 0 all pass, 1 any check failed,
2 could not run here (not root, not Linux, unknown distro family).

Options:
  --family=debian|rhel     Override the family auto-detected from /etc/os-release.
  --os-release=PATH        Read this os-release file instead of /etc/os-release.
  --package=PATH           The AppImage Vigil runs from (the RHEL family ships no
                           rpm package; a Debian-family .deb is detected itself).
  --uninstall-script=PATH  Where the helper's uninstall.sh lives when the app's
                           own copy is not at
                           "/opt/Vigil at Home/resources/helper/linux/uninstall.sh".
  --uninstall-roundtrip    Check 7 for real: uninstall the helper, assert nothing
                           is left behind, reinstall. Without it, check 7 is
                           read-only.
  --osquery-wait=SECONDS   How long to wait for the eBPF launch row (default 60).
  --self-test              Verify the harness itself — family detection, the
                           remedy registry, pass/fail wiring. Needs no root,
                           changes nothing.
  --help                   This text.
EOF
}

die() {
  printf 'validate-linux: %s\n' "$2" >&2
  exit "$1"
}

main() {
  local arg
  for arg in "$@"; do
    case $arg in
      --self-test) OPT_SELF_TEST=1 ;;
      --uninstall-roundtrip) OPT_ROUNDTRIP=1 ;;
      --family=*) OPT_FAMILY=${arg#--family=} ;;
      --os-release=*) OPT_OS_RELEASE=${arg#--os-release=} ;;
      --package=*) OPT_APPIMAGE=${arg#--package=} ;;
      --uninstall-script=*) OPT_UNINSTALL_SCRIPT=${arg#--uninstall-script=} ;;
      --osquery-wait=*) OPT_OSQUERY_WAIT=${arg#--osquery-wait=} ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        printf 'validate-linux: unknown argument %s\n\n' "$arg" >&2
        usage >&2
        exit 2
        ;;
    esac
  done

  # The self-test overrides every check with stubs, so it is safe anywhere.
  if [ -n "$OPT_SELF_TEST" ]; then
    self_test
    return
  fi

  if [ -n "$OPT_OSQUERY_WAIT" ]; then
    case $OPT_OSQUERY_WAIT in
      '' | *[!0-9]*) die 2 "--osquery-wait wants a number of seconds, got '$OPT_OSQUERY_WAIT'" ;;
    esac
    OSQUERY_WAIT=$OPT_OSQUERY_WAIT
  fi

  # Family first (pure text work): an unknown family must refuse even when
  # this shell is not root, so the error is never mistaken for a root problem.
  if [ -n "$OPT_FAMILY" ]; then
    case $OPT_FAMILY in
      debian | rhel) FAMILY=$OPT_FAMILY ;;
      *) die 2 "unknown family '$OPT_FAMILY' — debian or rhel" ;;
    esac
  else
    [ -f "$OPT_OS_RELEASE" ] || die 2 "no os-release at $OPT_OS_RELEASE — this routine is for Linux"
    FAMILY=$(family_from_osrelease "$(cat "$OPT_OS_RELEASE")")
  fi
  case $FAMILY in
    debian | rhel) ;;
    *)
      die 2 "distro family 'other' is not one this routine validates (from $OPT_OS_RELEASE). Debian family (apt) and RHEL family (dnf) are covered; Arch and friends get a manual routine — see the Omarchy notes in the docs"
      ;;
  esac

  [ "$(uname -s)" = Linux ] || die 2 "not Linux (uname says $(uname -s))"
  [ "$(id -u)" -eq 0 ] || die 2 "run as root (sudo) — the checks read systemd, fapolicyd and /run state only root sees"

  # shellcheck source=validate-linux/debian.sh
  source "$SCRIPT_DIR/validate-linux/$FAMILY.sh" || die 2 "family module for $FAMILY is missing"

  printf 'Validating Vigil at Home — %s\n' "$(family_label "$FAMILY")"
  trap cleanup EXIT
  if run_all_checks; then
    printf 'ALL PASS: %s checks on the %s family.\n' "${#CHECK_NAMES[@]}" "$FAMILY"
    exit 0
  fi
  printf 'FAILED: %s of %s checks (%s).\n' "$FAILURES" "${#CHECK_NAMES[@]}" "$(family_label "$FAMILY")"
  printf 'Remedies are printed with each FAIL above.\n'
  exit 1
}

main "$@"
