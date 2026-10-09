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

	/* Parent: real_parent is authoritative; fall back to the fork-fed map. */
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	__u32 parent = BPF_CORE_READ(task, real_parent, tgid);
	if (!parent) {
		__u32 tgid = e.tgid;
		__u32 *mapped = bpf_map_lookup_elem(&lineage, &tgid);
		parent = mapped ? *mapped : 0;
	}
	e.ppid = parent;

	/* Full path: the record carries bprm->filename in its dynamic data
	 * (TP_STRUCT__entry __string(filename, bprm->filename)). __data_loc
	 * puts the offset from the record start in the low 16 bits and the
	 * length in the high 16 (kernel include/trace/stages/
	 * stage3_trace_output.h __get_dynamic_array). The core recorded the
	 * comm here — same string as the basename, not a path. */
	__u32 loc = ctx->__data_loc_filename;
	bpf_probe_read_kernel_str(e.payload, sizeof(e.payload),
				  (const char *)ctx + (loc & 0xffff));

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

/* ===== Hook programs: file, network, privilege, module =====
 *
 * Every LSM hook has a kprobe twin encoding the identical payload; the
 * daemon attaches one per hook (plan in src/attach.c). All programs are
 * observe-only: return 0, never block. Byte layouts live in src/payload.h.
 */

#include "payload.h"
#include <bpf/bpf_endian.h>

static __always_inline void vig_fill_common(struct vig_event *e, __u32 kind)
{
	__u64 ug = bpf_get_current_uid_gid();
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();

	__builtin_memset(e, 0, sizeof(*e));
	e->kind = kind;
	e->mono_ns = bpf_ktime_get_ns();
	e->tgid = (__u32)(bpf_get_current_pid_tgid() >> 32);
	bpf_get_current_comm(e->comm, sizeof(e->comm));
	e->uid = (__u32)ug;
	e->euid = (__u32)(ug >> 32);
	e->ppid = BPF_CORE_READ(task, real_parent, tgid);
}

/* Per-CPU scratch for dentry-path composition: component strings walked
 * parent-ward, then composed root-down. Per-CPU keeps hook re-entrancy
 * safe without allocating per event. */
struct vig_dpath_scratch {
	char comp[16][24];
	__u8 len[16];
	__u8 n;
};

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct vig_dpath_scratch);
} path_scratch SEC(".maps");

/* Compose a dentry path as '/'-joined components, at most 16 levels and
 * within cap bytes; deeper trees lose the tail (the shallowest, most
 * location-bearing components are kept). Walking past a mountpoint
 * describes the underlying tree, not the mounted view — an index prefix,
 * never an authoritative path. Returns the composed length including the
 * NUL, or -1 when nothing could be read. */
static __always_inline int vig_dpath_compose(__u8 *out, int cap,
					     struct dentry *dent)
{
	struct vig_dpath_scratch *s;
	__u32 zero = 0;
	int i, off = 0;

	s = bpf_map_lookup_elem(&path_scratch, &zero);
	if (!s || !dent)
		return -1;
	__builtin_memset(s, 0, sizeof(*s));

#pragma unroll
	for (i = 0; i < 16; i++) {
		const char *nm =
			(const char *)BPF_CORE_READ(dent, d_name.name);
		int n = bpf_probe_read_kernel_str(s->comp[i], sizeof(s->comp[i]), nm);
		struct dentry *parent = BPF_CORE_READ(dent, d_parent);

		s->len[i] = (__u8)(n > 1 ? n - 1 : 0);
		if (s->len[i] > 23)
			s->len[i] = 23;
		s->n = (__u8)(i + 1);
		if (!parent || parent == dent)
			break;
		dent = parent;
	}

#pragma unroll
	for (i = 15; i >= 0; i--) {
		if (i >= s->n)
			continue;
		if (off + s->len[i] + 2 > cap)
			break;
		out[off] = '/';
		__builtin_memcpy(&out[off + 1], s->comp[i], 24);
		off += s->len[i] + 1;
	}
	if (off >= cap)
		off = cap - 1;
	out[off] = '\0';
	return off;
}

/* --- file mutations: open-for-write, unlink, rename, truncate --- */

static __always_inline void vig_file_open_body(struct file *file)
{
	__u32 flags = BPF_CORE_READ(file, f_flags);
	struct dentry *d;
	struct vig_event e;

	/* index mutation-shaped opens only: write access modes, or an open
	 * that can extend the file without one (O_TRUNC, O_APPEND) */
	if (!(flags & VIG_O_ACCMODE) && !(flags & (VIG_O_TRUNC | VIG_O_APPEND)))
		return;

	d = BPF_CORE_READ(file, f_path.dentry);
	vig_fill_common(&e, OP_FILE_MUT);
	e.payload[0] = VIG_FILE_OPEN_W;
	__builtin_memcpy(&e.payload[1], &flags, sizeof(flags)); /* LE */
	vig_dpath_compose(&e.payload[5], VIG_PAYLOAD_MAX - 5, d);
	push(&e);
}

static __always_inline void vig_file_unlink_body(struct dentry *dentry)
{
	struct vig_event e;

	vig_fill_common(&e, OP_FILE_MUT);
	e.payload[0] = VIG_FILE_UNLINK;
	vig_dpath_compose(&e.payload[1], VIG_PAYLOAD_MAX - 1, dentry);
	push(&e);
}

static __always_inline void vig_file_rename_body(struct dentry *old_d,
						 struct dentry *new_d)
{
	struct vig_event e;

	vig_fill_common(&e, OP_FILE_MUT);
	e.payload[0] = VIG_FILE_RENAME;
	vig_dpath_compose(&e.payload[1], VIG_PATH_CAP, old_d);
	vig_dpath_compose(&e.payload[1 + VIG_PATH_CAP],
			  VIG_PAYLOAD_MAX - 1 - VIG_PATH_CAP, new_d);
	push(&e);
}

static __always_inline void vig_file_truncate_body(struct file *file)
{
	struct dentry *d = BPF_CORE_READ(file, f_path.dentry);
	struct vig_event e;

	vig_fill_common(&e, OP_FILE_MUT);
	e.payload[0] = VIG_FILE_TRUNC;
	vig_dpath_compose(&e.payload[1], VIG_PAYLOAD_MAX - 1, d);
	push(&e);
}

SEC("lsm/file_open")
int BPF_PROG(vig_lsm_file_open, struct file *file)
{
	vig_file_open_body(file);
	return 0;
}

SEC("kprobe/security_file_open")
int BPF_KPROBE(vig_kp_file_open, struct file *file)
{
	vig_file_open_body(file);
	return 0;
}

SEC("lsm/inode_unlink")
int BPF_PROG(vig_lsm_inode_unlink, struct inode *dir, struct dentry *dentry)
{
	vig_file_unlink_body(dentry);
	return 0;
}

SEC("kprobe/security_inode_unlink")
int BPF_KPROBE(vig_kp_inode_unlink, struct inode *dir, struct dentry *dentry)
{
	vig_file_unlink_body(dentry);
	return 0;
}

SEC("lsm/inode_rename")
int BPF_PROG(vig_lsm_inode_rename, struct inode *old_dir,
	     struct dentry *old_dentry, struct inode *new_dir,
	     struct dentry *new_dentry, unsigned int flags)
{
	vig_file_rename_body(old_dentry, new_dentry);
	return 0;
}

SEC("kprobe/security_inode_rename")
int BPF_KPROBE(vig_kp_inode_rename, struct inode *old_dir,
	       struct dentry *old_dentry, struct inode *new_dir,
	       struct dentry *new_dentry, unsigned int flags)
{
	vig_file_rename_body(old_dentry, new_dentry);
	return 0;
}

SEC("lsm/file_truncate")
int BPF_PROG(vig_lsm_file_truncate, struct file *file)
{
	vig_file_truncate_body(file);
	return 0;
}

SEC("kprobe/security_file_truncate")
int BPF_KPROBE(vig_kp_file_truncate, struct file *file)
{
	vig_file_truncate_body(file);
	return 0;
}

/* --- network: connect attempts, binds, listens --- */

static __always_inline void vig_net_addr_fill(struct vig_event *e, int base,
					      const struct sockaddr *addr)
{
	__u16 fam = BPF_CORE_READ(addr, sa_family);

	__builtin_memcpy(&e->payload[base], &fam, sizeof(fam)); /* LE */
	if (fam == VIG_AF_INET) {
		struct sockaddr_in *sin = (struct sockaddr_in *)addr;
		__u16 port = bpf_ntohs(BPF_CORE_READ(sin, sin_port));

		__builtin_memcpy(&e->payload[base + 2], &port, sizeof(port));
		BPF_CORE_READ_INTO(&e->payload[base + 4], sin, sin_addr);
	} else if (fam == VIG_AF_INET6) {
		struct sockaddr_in6 *s6 = (struct sockaddr_in6 *)addr;
		__u16 port = bpf_ntohs(BPF_CORE_READ(s6, sin6_port));

		__builtin_memcpy(&e->payload[base + 2], &port, sizeof(port));
		BPF_CORE_READ_INTO(&e->payload[base + 4], s6, sin6_addr);
	} else if (fam == VIG_AF_UNIX) {
		struct sockaddr_un *su = (struct sockaddr_un *)addr;

		BPF_CORE_READ_STR_INTO(&e->payload[base + 4], su, sun_path);
	}
	/* unknown family: record the family only — no address is guessed */
}

static __always_inline void vig_connect_body(const struct sockaddr *addr)
{
	struct vig_event e;

	vig_fill_common(&e, OP_NET_CONN);
	vig_net_addr_fill(&e, 4, addr); /* no op byte on connection records */
	push(&e);
}

static __always_inline void vig_bind_body(const struct sockaddr *addr)
{
	struct vig_event e;

	vig_fill_common(&e, OP_NET_LISTEN);
	e.payload[0] = VIG_NET_BIND;
	vig_net_addr_fill(&e, 5, addr);
	push(&e);
}

/* listen has no sockaddr argument: read the bound identity from the sock */
static __always_inline void vig_listen_body(struct socket *sock)
{
	struct sock *sk = BPF_CORE_READ(sock, sk);
	struct vig_event e;
	__u16 fam, port;
	int base = 1;

	if (!sk)
		return;
	vig_fill_common(&e, OP_NET_LISTEN);
	e.payload[0] = VIG_NET_LISTEN_OP;
	fam = BPF_CORE_READ(sk, __sk_common.skc_family);
	port = BPF_CORE_READ(sk, __sk_common.skc_num); /* already host order */
	__builtin_memcpy(&e.payload[base], &fam, sizeof(fam));
	__builtin_memcpy(&e.payload[base + 2], &port, sizeof(port));
	if (fam == VIG_AF_INET)
		BPF_CORE_READ_INTO(&e.payload[base + 4], sk,
				   __sk_common.skc_rcv_saddr);
	else if (fam == VIG_AF_INET6)
		BPF_CORE_READ_INTO(&e.payload[base + 4], sk,
				   __sk_common.skc_v6_rcv_saddr);
	push(&e);
}

SEC("lsm/socket_connect")
int BPF_PROG(vig_lsm_socket_connect, struct socket *sock,
	     struct sockaddr *address, int addrlen)
{
	vig_connect_body(address);
	return 0;
}

SEC("kprobe/security_socket_connect")
int BPF_KPROBE(vig_kp_socket_connect, struct socket *sock,
	       struct sockaddr *address, int addrlen)
{
	vig_connect_body(address);
	return 0;
}

SEC("lsm/socket_bind")
int BPF_PROG(vig_lsm_socket_bind, struct socket *sock,
	     struct sockaddr *address, int addrlen)
{
	vig_bind_body(address);
	return 0;
}

SEC("kprobe/security_socket_bind")
int BPF_KPROBE(vig_kp_socket_bind, struct socket *sock,
	       struct sockaddr *address, int addrlen)
{
	vig_bind_body(address);
	return 0;
}

SEC("lsm/socket_listen")
int BPF_PROG(vig_lsm_socket_listen, struct socket *sock, int backlog)
{
	vig_listen_body(sock);
	return 0;
}

SEC("kprobe/security_socket_listen")
int BPF_KPROBE(vig_kp_socket_listen, struct socket *sock, int backlog)
{
	vig_listen_body(sock);
	return 0;
}

/* --- privilege: capset hook plus the commit_creds surface --- */

static __always_inline void vig_priv_fill(struct vig_event *e,
					  const struct cred *old,
					  const struct cred *newc, __u8 src)
{
	kuid_t from_k = BPF_CORE_READ(old, euid);
	kuid_t to_k = BPF_CORE_READ(newc, euid);
	__u32 from = from_k.val;
	__u32 to = to_k.val;
	__u64 caps = 0;

	/* the new permitted set: __u32 cap[2] on 6.1, u64 on 6.12 — the
	 * raw 8 bytes have the same bit layout on both */
	BPF_CORE_READ_INTO(&caps, newc, cap_permitted);

	vig_fill_common(e, OP_PRIV);
	__builtin_memcpy(&e->payload[0], &from, sizeof(from)); /* LE */
	__builtin_memcpy(&e->payload[4], &to, sizeof(to));     /* LE */
	__builtin_memcpy(&e->payload[8], &caps, sizeof(caps)); /* LE */
	e->payload[16] = src;
}

SEC("lsm/capset")
int BPF_PROG(vig_lsm_capset, struct cred *new, const struct cred *old,
	     const kernel_cap_t *effective, const kernel_cap_t *inheritable,
	     const kernel_cap_t *permitted)
{
	struct vig_event e;

	vig_priv_fill(&e, old, new, VIG_PRIV_CAPSET);
	push(&e);
	return 0;
}

SEC("kprobe/security_capset")
int BPF_KPROBE(vig_kp_capset, struct cred *new, const struct cred *old,
	       const kernel_cap_t *effective, const kernel_cap_t *inheritable,
	       const kernel_cap_t *permitted)
{
	struct vig_event e;

	vig_priv_fill(&e, old, new, VIG_PRIV_CAPSET);
	push(&e);
	return 0;
}

/* commit_creds covers every credential change, including the setuid
 * family, which the capset hook does not see. Always attached. */
SEC("kprobe/commit_creds")
int BPF_KPROBE(vig_kp_commit_creds, struct cred *new)
{
	struct task_struct *task = (struct task_struct *)bpf_get_current_task();
	const struct cred *old = BPF_CORE_READ(task, cred);
	struct vig_event e;

	if (old)
		vig_priv_fill(&e, old, new, VIG_PRIV_CREDS);
	push(&e);
	return 0;
}

/* --- kernel modules: load/unload tracepoints --- */

/* Mirror tracepoint records, verified against include/trace/events/module.h
 * on v6.1 and v6.12 (load: trace_entry, u32 taints, __data_loc name;
 * free: trace_entry, __data_loc name). Defined here rather than taken from
 * vmlinux.h because tracepoint structs only exist in kernels' BTF where the
 * subsystem compiled them in; the wire format is what matters. */
struct vig_tp_module_load {
	struct trace_entry ent;
	__u32 taints;
	__u32 __data_loc_name;
};

struct vig_tp_module_free {
	struct trace_entry ent;
	__u32 __data_loc_name;
};

SEC("tracepoint/module/module_load")
int on_module_load(struct vig_tp_module_load *ctx)
{
	struct vig_event e;
	__u32 loc = ctx->__data_loc_name;

	vig_fill_common(&e, OP_MODULE);
	e.payload[0] = VIG_MODULE_LOAD;
	bpf_probe_read_kernel_str(&e.payload[1], VIG_PAYLOAD_MAX - 1,
				  (const char *)ctx + (loc & 0xffff));
	push(&e);
	return 0;
}

SEC("tracepoint/module/module_free")
int on_module_free(struct vig_tp_module_free *ctx)
{
	struct vig_event e;
	__u32 loc = ctx->__data_loc_name;

	vig_fill_common(&e, OP_MODULE);
	e.payload[0] = VIG_MODULE_UNLOAD;
	bpf_probe_read_kernel_str(&e.payload[1], VIG_PAYLOAD_MAX - 1,
				  (const char *)ctx + (loc & 0xffff));
	push(&e);
	return 0;
}

/* The kernel resolves its gpl-only helpers (bpf_ktime_get_ns,
 * bpf_get_current_comm, ...) against this string; "Dual BSD/GPL" is the
 * GPL-compatible marker. The source itself is Apache-2.0 like the repo. */
char LICENSE[] SEC("license") = "Dual BSD/GPL";
