#!/usr/bin/env bash
# Best-effort verifier signal on a host without attach privileges.
#
# Real verification needs a kernel that accepts BPF_PROG_LOAD — hosted CI
# runners cannot attach, so this script compiles the object, then checks that
# every program section is present and the object's BTF is intact. A loadable
# kernel (Debian VM) remains the authoritative verifier check; see the PR's
# VM-pending list.
set -euo pipefail

cd "$(dirname "$0")/.."

bpftool_bin="$(command -v bpftool || true)"
[[ -z "$bpftool_bin" && -x /usr/sbin/bpftool ]] && bpftool_bin=/usr/sbin/bpftool
[[ -n "$bpftool_bin" ]] || { echo "bpftool not found" >&2; exit 1; }

# llvm-objdump is unversioned on full llvm installs, versioned (-N) otherwise
objdump_bin="$(command -v llvm-objdump || true)"
if [[ -z "$objdump_bin" ]]; then
	for d in /usr/lib/llvm-*/bin/llvm-objdump; do
		[[ -x "$d" ]] && objdump_bin="$d" && break
	done
fi
[[ -n "$objdump_bin" ]] || { echo "llvm-objdump not found" >&2; exit 1; }

obj=bpf/vigil.bpf.o
[[ -f "$obj" ]] || { echo "missing $obj (run make first)" >&2; exit 1; }

echo "== program sections in $obj =="
"$objdump_bin" -h "$obj" | sed -n 's/^ *[0-9][0-9]* \(.*\.bpf\.[a-z_]*\|.*lsm\/[a-z_]*\|.*tracepoint\/[a-z_/]*\).*/\1/p'

# Capture full outputs first: `grep -q` closes the pipe early, and under
# pipefail the producer's SIGPIPE would make a FOUND section read as
# missing.
sections_btf="$("$bpftool_bin" btf dump file "$obj" 2>/dev/null || true)"
sections_hdr="$("$objdump_bin" -h "$obj" || true)"

for sec in \
	tracepoint/sched/sched_process_exec \
	tracepoint/sched/sched_process_fork \
	tracepoint/module/module_load \
	tracepoint/module/module_free \
	lsm/file_open \
	lsm/inode_unlink \
	lsm/inode_rename \
	lsm/file_truncate \
	lsm/socket_connect \
	lsm/socket_bind \
	lsm/socket_listen \
	lsm/capset \
	kprobe/security_file_open \
	kprobe/security_inode_unlink \
	kprobe/security_inode_rename \
	kprobe/security_file_truncate \
	kprobe/security_socket_connect \
	kprobe/security_socket_bind \
	kprobe/security_socket_listen \
	kprobe/security_capset \
	kprobe/commit_creds; do
	if ! grep -q "$sec" <<<"$sections_btf" &&
	   ! grep -q "$sec" <<<"$sections_hdr"; then
		echo "FAIL: section $sec missing" >&2
		exit 1
	fi
done

"$bpftool_bin" btf dump file "$obj" > /dev/null
echo "verifier pre-check OK: sections present, BTF parses (load-time verify runs on the target kernel)"
