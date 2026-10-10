#!/usr/bin/env bash
# Generate vmlinux.h from a kernel BTF image.
#
# Usage: gen_vmlinux.sh [OUTPUT]
#
# With no BTF_SOURCE set, uses the running kernel's BTF. CI sets BTF_SOURCE to
# a Debian 12 (6.1) or Debian 13 (6.12) vmlinux BTF blob so the CO-RE object
# is proven to compile against both target kernels.
set -euo pipefail

out="${1:?usage: gen_vmlinux.sh OUTPUT}"
btf="${BTF_SOURCE:-/sys/kernel/btf/vmlinux}"

bpftool_bin="$(command -v bpftool || true)"
[[ -z "$bpftool_bin" && -x /usr/sbin/bpftool ]] && bpftool_bin=/usr/sbin/bpftool
[[ -n "$bpftool_bin" ]] || { echo "gen_vmlinux.sh: bpftool not found" >&2; exit 1; }

if [[ ! -r "$btf" ]]; then
	echo "gen_vmlinux.sh: BTF source not readable: $btf" >&2
	exit 1
fi

"$bpftool_bin" btf dump file "$btf" format c > "$out"
echo "gen_vmlinux.sh: wrote $out from $btf"
