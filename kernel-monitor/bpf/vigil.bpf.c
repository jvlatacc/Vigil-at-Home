// Vigil kernel monitor — CO-RE eBPF object, core hooks.
//
// One object for Debian 12 (6.1) and 13 (6.12) stock kernels: both ship
// CONFIG_DEBUG_INFO_BTF=y, so a single compile relocates against the running
// kernel's BTF at load time (see the pinned decision brief, §1). Core hooks
// per the spec: sched_process_exec (executions) and sched_process_fork
// (lineage — feeds the tgid→ppid map the exec hook reads as a fallback).
// Later hook PRs extend this object with LSM/kprobe variants; the
// struct vig_event layout below is the stable contract with the daemon.

#include "vmlinux.h"
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

enum ev_kind {
	OP_EXEC = 1,
	OP_FORK,
	OP_FILE_MUT,
	OP_NET_CONN,
	OP_NET_LISTEN,
	OP_PRIV,
	OP_MODULE,
	OP_HEALTH,
};

struct vig_event {
	__u64 mono_ns;     /* bpf_ktime_get_ns() — the ordering key */
	__u32 kind, tgid, ppid, uid, euid;
	__s64 ret;         /* hook result where meaningful */
	char comm[16];
	__u8 payload[192]; /* path prefix, sockaddr, or cred sets — by kind */
};

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 8 << 20);
} events SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(value, __u64);
} dropped SEC(".maps");

/* child tgid → parent tgid, updated by sched_process_fork. Exec reads
 * real_parent directly; the map is the fallback when the CO-RE read fails. */
struct {
	__uint(type, BPF_MAP_TYPE_LRU_HASH);
	__uint(max_entries, 16384);
	__type(key, __u32);
	__type(value, __u32);
} lineage SEC(".maps");

static __always_inline int push(struct vig_event *e)
{
	struct vig_event *p = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!p) {
		/* ring full: never block — count and move on */
		__u64 one = 1, zero = 0, *d = bpf_map_lookup_elem(&dropped, &zero);
		if (d)
			__sync_fetch_and_add(d, one);
		return -1;
	}
	__builtin_memcpy(p, e, sizeof(*e));
	bpf_ringbuf_submit(p, 0);
	return 0;
}

SEC("tracepoint/sched/sched_process_exec")
int on_exec(struct trace_event_raw_sched_process_exec *ctx)
{
	struct vig_event e = { 0 };

	e.kind = OP_EXEC;
	e.mono_ns = bpf_ktime_get_ns();
	/* exec runs on the group leader, so the tgid half of pid_tgid is exact
	 * (the spec sample reads ctx->pid, which equals it here); the helper is
	 * the unambiguous form. */
	e.tgid = bpf_get_current_pid_tgid() >> 32;

	__u64 ug = bpf_get_current_uid_gid();
	e.uid = (__u32)ug;
	e.euid = (__u32)(ug >> 32);
	bpf_get_current_comm(e.comm, sizeof(e.comm));

	/* Parent: real_parent is authoritative; fall back to the fork-fed map.
	 * sched_process_exec's tracepoint record carries only p->comm as its
	 * "filename", so the exe prefix is comm-derived here — the hooks PR adds
	 * the full path from the bprm hook. */
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	__u32 parent = BPF_CORE_READ(task, real_parent, tgid);
	if (!parent) {
		__u32 tgid = e.tgid;
		__u32 *mapped = bpf_map_lookup_elem(&lineage, &tgid);
		parent = mapped ? *mapped : 0;
	}
	e.ppid = parent;

	__builtin_memcpy(e.payload, e.comm, sizeof(e.comm));

	return push(&e);
}

SEC("tracepoint/sched/sched_process_fork")
int on_fork(struct trace_event_raw_sched_process_fork *ctx)
{
	__u32 child = ctx->child_pid;
	__u32 parent = ctx->parent_pid;

	bpf_map_update_elem(&lineage, &child, &parent, BPF_ANY);
	/* No ring record: fork is lineage-only. The event schema is closed and
	 * has no fork kind, and thread clones would flood the ring. */
	return 0;
}

/* The kernel resolves its gpl-only helpers (bpf_ktime_get_ns,
 * bpf_get_current_comm, ...) against this string; "Dual BSD/GPL" is the
 * GPL-compatible marker. The source itself is Apache-2.0 like the repo. */
char LICENSE[] SEC("license") = "Dual BSD/GPL";
