#!/bin/sh
# vigil-flow installer — provisions the vigil-flow NetFlow sensor jail on an
# OPNsense appliance (component spec art_4ou8t1mZ, locked decisions 1 and 6).
#
# POSIX sh; run as root on the OPNsense host. Idempotent: re-runs refresh the
# generated files and never duplicate fragments. Every failure prints a named
# cause and exits non-zero.
#
# The jail userland comes from the matching FreeBSD base.txz and softflowd is
# installed into the jail root via `pkg -r`; nothing lands on the host except
# the fragments, the config, and the configd integration. fetch(1) and tar(1)
# are used because they are part of the FreeBSD base system.
#
# Testing contract: when VIGIL_FLOW_SKIP_MAIN is set, sourcing this file only
# defines functions — the bats suite (appliance/opnsense/tests) exercises
# them hermetically by pointing the location variables below at a temp dir.

# Overridable locations (tests repoint these at a temporary sandbox).
VIGIL_ROOT=${VIGIL_ROOT:-/var/vigil-flow}
JAIL_ROOT=${JAIL_ROOT:-$VIGIL_ROOT/jail}
DEVFS_RULES_FILE=${DEVFS_RULES_FILE:-/etc/devfs.rules}
JAIL_CONF_INCLUDE_FILE=${JAIL_CONF_INCLUDE_FILE:-/etc/jail.conf}
JAIL_CONF_DIR=${JAIL_CONF_DIR:-/etc/jail.conf.d}
ACTION_DIR=${ACTION_DIR:-/usr/local/opnsense/service/conf/actions.d}
HOST_WRAPPER=${HOST_WRAPPER:-/usr/local/bin/vigil-flow-jail-ctl.sh}
MANIFEST_FILE=${MANIFEST_FILE:-$VIGIL_ROOT/install-manifest.txt}
BASE_URL_PREFIX=${BASE_URL_PREFIX:-https://download.freebsd.org/ftp/releases}
DEFAULT_COLLECTOR_PORT=${DEFAULT_COLLECTOR_PORT:-2550}
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
usage: install.sh --interfaces IFACE[,IFACE...] --collector HOST[:PORT] --ip ADDRESS [--version 9|ipfix]

Provisions the $JAIL_NAME jail, devfs ruleset, sensor configuration, and
configd actions on this OPNsense host. Run as root.

  --interfaces   Comma-separated host interfaces to capture (e.g. lan0).
  --collector    Off-device NetFlow collector as HOST[:PORT]; PORT defaults
                 to $DEFAULT_COLLECTOR_PORT (product decision).
  --ip           IPv4 address assigned to the jail (rides the host stack).
  --version      NetFlow export version: 9 (default) or ipfix.
  -h, --help     Show this help.
EOF
}

is_valid_port() {
  # $1 = candidate port. Numeric and within 1-65535.
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

is_valid_ipv4() {
  # $1 = candidate dotted-quad IPv4 address.
  _old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086  # $1 must split on the '.' set above
  set -- $1
  IFS=$_old_ifs
  [ "$#" -eq 4 ] || return 1
  for _octet in "$@"; do
    case $_octet in
      '' | *[!0-9]*) return 1 ;;
    esac
    [ "$_octet" -le 255 ] || return 1
  done
  return 0
}

split_collector() {
  # $1 = collector spec HOST[:PORT]; sets COLLECTOR_HOST / COLLECTOR_PORT.
  # A bare host takes the product-default port. IPv6 literals are rejected
  # in v1: the config surface carries exactly one host and one port.
  case $1 in
    '' | :*)
      err "collector '$1': host part is empty (expected HOST[:PORT])"
      return 1
      ;;
    *:*)
      COLLECTOR_HOST=${1%:*}
      COLLECTOR_PORT=${1##*:}
      case $COLLECTOR_HOST in
        *:*)
          err "collector '$1': too many colons; IPv6 literals are not supported in v1"
          return 1
          ;;
      esac
      is_valid_port "$COLLECTOR_PORT" || {
        err "collector '$1': port '$COLLECTOR_PORT' is outside 1-65535"
        return 1
      }
      ;;
    *)
      COLLECTOR_HOST=$1
      COLLECTOR_PORT=$DEFAULT_COLLECTOR_PORT
      ;;
  esac
}

validate_interfaces() {
  # $1 = comma-separated capture interface list. Syntax only; existence on
  # the host stack is checked at runtime by assert_interfaces_exist.
  case $1 in
    '' | ,* | *, | *,,*)
      err "capture_interfaces '$1': every entry must be a non-empty interface name"
      return 1
      ;;
  esac
  # The comma is the list separator, so validate each token's characters
  # individually rather than the raw joined string.
  _vf_list=$1
  while [ -n "$_vf_list" ]; do
    _vf_tok=${_vf_list%%,*}
    case $_vf_tok in
      '' | *[!A-Za-z0-9._-]*)
        err "capture_interfaces '$_vf_tok': only [A-Za-z0-9._-] are allowed in interface names"
        return 1
        ;;
    esac
    [ "$_vf_tok" = "$_vf_list" ] && break
    _vf_list=${_vf_list#*,}
  done
}

validate_netflow_version() {
  # $1 = netflow_version config value.
  case $1 in
    9 | ipfix) return 0 ;;
    *) err "netflow_version '$1' must be 9 or ipfix"; return 1 ;;
  esac
}

parse_args() {
  # Parses CLI flags into INTERFACES / COLLECTOR_HOST / COLLECTOR_PORT /
  # JAIL_IP / NF_VERSION. Returns 1 with a named cause on stderr instead of
  # exiting, so tests can assert rejections.
  INTERFACES=''
  COLLECTOR_HOST=''
  COLLECTOR_PORT=$DEFAULT_COLLECTOR_PORT
  JAIL_IP=''
  NF_VERSION=9
  while [ "$#" -gt 0 ]; do
    case $1 in
      --interfaces)
        [ "$#" -ge 2 ] || { err "--interfaces requires a value"; return 1; }
        INTERFACES=$2
        shift 2
        ;;
      --collector)
        [ "$#" -ge 2 ] || { err "--collector requires a value"; return 1; }
        split_collector "$2" || return 1
        shift 2
        ;;
      --ip)
        [ "$#" -ge 2 ] || { err "--ip requires a value"; return 1; }
        JAIL_IP=$2
        shift 2
        ;;
      --version)
        [ "$#" -ge 2 ] || { err "--version requires a value"; return 1; }
        NF_VERSION=$2
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        err "unknown option: $1"
        return 1
        ;;
    esac
  done

  validate_interfaces "$INTERFACES" || return 1
  [ -n "$COLLECTOR_HOST" ] || { err "missing required --collector (HOST[:PORT])"; return 1; }
  [ -n "$JAIL_IP" ] || { err "missing required --ip ADDRESS"; return 1; }
  is_valid_ipv4 "$JAIL_IP" || { err "--ip '$JAIL_IP' is not a valid IPv4 address"; return 1; }
  validate_netflow_version "$NF_VERSION" || return 1
}

arch_from_uname() {
  # $1 = uname -m output -> FreeBSD release directory name.
  case $1 in
    x86_64 | amd64) printf 'amd64\n' ;;
    aarch64 | arm64) printf 'arm64\n' ;;
    i386) printf 'i386\n' ;;
    *)
      err "unsupported architecture '$1': no FreeBSD base.txz mapping"
      return 1
      ;;
  esac
}

freebsd_release_from_userland() {
  # $1 = `freebsd-version -u` output -> the matching -RELEASE build that has
  # a downloadable base.txz. Patch levels (14.2-RELEASE-p3) map to the base
  # release; -STABLE/-CURRENT/-PRERELEASE builds have no release artifact.
  case $1 in
    *-STABLE | *-CURRENT | *-PRERELEASE | *-ALPHA*)
      err "userland '$1' is not a -RELEASE build: no base.txz exists for it"
      return 1
      ;;
    *-RELEASE)
      printf '%s\n' "$1"
      ;;
    *-RELEASE-*)
      printf '%s\n' "${1%%-p*}"
      ;;
    *)
      err "unrecognized freebsd-version -u output '$1'"
      return 1
      ;;
  esac
}

pkg_abi_for() {
  # $1 = release (e.g. 14.2-RELEASE), $2 = arch -> pkg ABI string for jail.
  _major=${1%%.*}
  printf 'FreeBSD:%s:%s\n' "$_major" "$2"
}

base_txz_url() {
  # $1 = release, $2 = arch -> official FreeBSD download URL for base.txz.
  printf '%s/%s/%s/base.txz\n' "$BASE_URL_PREFIX" "$2" "$1"
}

detect_abi() {
  # Sets USERLAND_VERSION, RELEASE, ARCH, PKG_ABI, BASE_TXZ_URL.
  command -v freebsd-version >/dev/null 2>&1 ||
    die "freebsd-version not found: cannot detect the jail userland ABI"
  USERLAND_VERSION=$(freebsd-version -u) ||
    die "freebsd-version -u failed: cannot detect the userland version"
  RELEASE=$(freebsd_release_from_userland "$USERLAND_VERSION") ||
    die "cannot derive a downloadable base release from userland '$USERLAND_VERSION'"
  ARCH=$(arch_from_uname "$(uname -m)") ||
    die "cannot map this machine's architecture to a FreeBSD release directory"
  PKG_ABI=$(pkg_abi_for "$RELEASE" "$ARCH")
  BASE_TXZ_URL=$(base_txz_url "$RELEASE" "$ARCH")
}

assert_interfaces_exist() {
  # Runtime check — the non-VNET jail shares the host network stack, so host
  # ifconfig is authoritative. Needs a real host, so CI never calls it.
  _host_ifaces=$(ifconfig -l) ||
    die "ifconfig -l failed: cannot verify the capture interfaces"
  for _iface in $(printf '%s' "$INTERFACES" | tr ',' ' '); do
    case " $_host_ifaces " in
      *" $_iface "*) ;;
      *) die "capture interface '$_iface' does not exist on this host" ;;
    esac
  done
}

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

append_devfs_fragment() {
  # $1 = target rules file. Appends the marked vigil-flow ruleset once; the
  # markers make the block auditable and let uninstall.sh strip it exactly.
  if [ -f "$1" ] && grep -q '^# >>> vigil-flow >>>' "$1"; then
    printf '%s: devfs fragment already present, skipping\n' "${0##*/}"
    return 0
  fi
  cat >> "$1" <<'EOF'

# >>> vigil-flow >>> (added by appliance/opnsense/install.sh)
[devfsrules_vigil_flow=5]
add include $devfsrules_jail
add path 'bpf*' unhide
# <<< vigil-flow <<<
EOF
}

ensure_jail_conf_include() {
  # $1 = /etc/jail.conf. jail(8) only reads /etc/jail.conf.d/*.conf through
  # an explicit .include directive, so make sure one is present exactly once
  # — whoever added it.
  if [ -f "$1" ] && grep -Fq '.include "/etc/jail.conf.d/*.conf";' "$1"; then
    return 0
  fi
  cat >> "$1" <<'EOF'

# >>> vigil-flow-jailconf >>> (added by appliance/opnsense/install.sh)
.include "/etc/jail.conf.d/*.conf";
# <<< vigil-flow-jailconf <<<
EOF
}

write_jail_conf() {
  # Emits /etc/jail.conf.d/vigil-flow.conf from the validated flags.
  # Non-VNET: the jail shares the host network stack so softflowd inside it
  # can open the unhidden bpf devices on host interfaces (locked decision 1).
  mkdir -p "$JAIL_CONF_DIR" || return 1
  cat > "$JAIL_CONF_DIR/vigil-flow.conf" <<EOF
# vigil-flow jail — generated by appliance/opnsense/install.sh. Do not edit
# by hand: rerun the installer (or configctl vigil-flow reconfigure) instead.
$JAIL_NAME {
  devfs_ruleset = 5;  # [devfsrules_vigil_flow] — grants /dev/bpf* visibility
  mount.devfs;
  path = $JAIL_ROOT;
  ip4.addr = $JAIL_IP;
  exec.start = "/usr/local/bin/vigil-flow-ctl.sh start";
  exec.stop = "/usr/local/bin/vigil-flow-ctl.sh stop";
  persist;
}
EOF
}

write_sensor_config() {
  # Emits the POSIX key = value sensor config inside the jail root, using
  # the exact keys from the component spec.
  mkdir -p "$JAIL_ROOT/etc" || return 1
  cat > "$JAIL_ROOT/etc/vigil-flow.conf" <<EOF
# vigil-flow sensor configuration (installed by appliance/opnsense/install.sh)

# Capture on these host interfaces, seen through unhidden /dev/bpf*.
capture_interfaces = "$INTERFACES"

# Off-device NetFlow collector.
collector_host = "$COLLECTOR_HOST"
collector_port = "$COLLECTOR_PORT"

# 9 | ipfix (maps to softflowd -v 9 | -v 10)
netflow_version = "$NF_VERSION"

# Flow timeouts and limits (passed to softflowd -t / -m).
active_timeout = "300"
inactive_timeout = "30"
max_flows = "8192"

# Health/status output (JSON, rewritten on every transition and stats poll).
status_file = "/var/db/vigil-flow/status.json"
EOF
}

write_configd_action() {
  # Registers configctl vigil-flow status|reconfigure actions. The status
  # action returns output, so it uses script_output; reconfigure is a plain
  # script (OPNsense configd conventions).
  mkdir -p "$ACTION_DIR" || return 1
  cat > "$ACTION_DIR/actions_vigil-flow.conf" <<EOF
# vigil-flow configd actions — generated by appliance/opnsense/install.sh
[status]
command:$HOST_WRAPPER status
parameters:
type:script_output
message:vigil-flow status query

[reconfigure]
command:$HOST_WRAPPER reconfigure
parameters:
type:script
message:vigil-flow reconfigure
EOF
}

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

fetch_base_txz() {
  # Fetches the matching FreeBSD base.txz unless the jail userland is
  # already in place (idempotent re-runs must not re-download).
  if [ -f "$JAIL_ROOT/bin/sh" ]; then
    printf '%s: jail userland already present, skipping base.txz fetch\n' "${0##*/}"
    return 0
  fi
  mkdir -p "$JAIL_ROOT" || die "cannot create $JAIL_ROOT"
  printf '%s: fetching %s\n' "${0##*/}" "$BASE_TXZ_URL"
  fetch -o "$JAIL_ROOT/base.txz" "$BASE_TXZ_URL" ||
    die "fetching $BASE_TXZ_URL failed: check network egress and the release name"
}

extract_base_txz() {
  if [ -f "$JAIL_ROOT/bin/sh" ]; then
    printf '%s: jail userland already present, skipping extraction\n' "${0##*/}"
    return 0
  fi
  tar -C "$JAIL_ROOT" -xzf "$JAIL_ROOT/base.txz" ||
    die "extracting $JAIL_ROOT/base.txz failed: the jail root may be unusable"
  rm -f "$JAIL_ROOT/base.txz"
}

install_softflowd() {
  # Installs softflowd into the jail root via pkg -r with the jail
  # userland's ABI override (locked decision 6: zero packages on the host).
  if [ -x "$JAIL_ROOT/usr/local/sbin/softflowd" ]; then
    printf '%s: softflowd already installed in jail, skipping\n' "${0##*/}"
    return 0
  fi
  ASSUME_ALWAYS_YES=yes ABI="$PKG_ABI" pkg -r "$JAIL_ROOT" update ||
    die "pkg -r update failed: cannot refresh the package catalog for the jail"
  ASSUME_ALWAYS_YES=yes ABI="$PKG_ABI" pkg -r "$JAIL_ROOT" install --yes softflowd ||
    die "pkg -r install softflowd failed: see the pkg output above"
}

main() {
  set -eu

  [ "$(id -u)" -eq 0 ] || die "this installer must run as root"
  command -v opnsense-version >/dev/null 2>&1 ||
    die "opnsense-version not found: this installer must run on an OPNsense appliance"

  parse_args "$@" || die "invalid arguments (run with --help)"
  detect_abi
  assert_interfaces_exist

  mkdir -p "$VIGIL_ROOT" || die "cannot create $VIGIL_ROOT"
  write_manifest || die "cannot write $MANIFEST_FILE"

  printf '%s: provisioning %s from %s (ABI %s)\n' "${0##*/}" "$JAIL_NAME" "$BASE_TXZ_URL" "$PKG_ABI"
  fetch_base_txz
  extract_base_txz
  install_softflowd

  append_devfs_fragment "$DEVFS_RULES_FILE" || die "cannot append the devfs fragment to $DEVFS_RULES_FILE"
  ensure_jail_conf_include "$JAIL_CONF_INCLUDE_FILE" || die "cannot ensure the jail.conf include in $JAIL_CONF_INCLUDE_FILE"
  write_jail_conf || die "cannot write $JAIL_CONF_DIR/vigil-flow.conf"
  write_sensor_config || die "cannot write the sensor configuration"
  write_configd_action || die "cannot write $ACTION_DIR/actions_vigil-flow.conf"
  copy_host_wrapper

  printf '%s: done. Next steps:\n' "${0##*/}"
  printf '  1. service configd restart   # pick up the vigil-flow actions\n'
  printf '  2. install the vigil-flow daemon scripts (sensor component), then:\n'
  printf '  3. service jail start %s && configctl %s status\n' "$JAIL_NAME" "$JAIL_NAME"
}

SCRIPT_DIR=$(CDPATH='' cd "$(dirname "$0")" && pwd)

if [ "${VIGIL_FLOW_SKIP_MAIN:-0}" = "1" ]; then
  : # sourced for hermetic testing — define functions only
else
  main "$@"
fi
