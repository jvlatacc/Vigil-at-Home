# `arch_from_uname` — install.sh

**Script:** `appliance/opnsense/install.sh`. Maps the machine architecture to
the FreeBSD release directory name.

```sh
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
```

## Purpose

Translate `uname -m` output (which differs between platforms — `x86_64` on
Linux versus `amd64` on FreeBSD) into the directory name used on the FreeBSD
download server, so the installer fetches the base.txz that matches this
machine.

## Inputs and outputs

- Input: `$1` — a `uname -m` string.
- Output: `amd64`, `arm64`, or `i386` on stdout.
- Return status: 0 on a known mapping, 1 otherwise.

## Side effects

None — pure function.

## Failure modes and exit codes

Returns 1 with `unsupported architecture '$1': no FreeBSD base.txz mapping`
for any unmapped architecture. `detect_abi` turns that into a fatal error.

## Tests covering it

No direct bats case (it is a thin mapping over `uname -m`; the installer suite
exercises the release and URL mappings around it). The mapping is confirmed on
device by the ABI line `main` prints before provisioning.

## Linked decisions

- [0006 — Jail userland from base.txz, zero host packages](../decisions/0006-jail-userland-base-txz-softflowd.md)
