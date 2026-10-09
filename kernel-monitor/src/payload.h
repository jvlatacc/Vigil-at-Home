/* Byte-level payload contract for struct vig_event.payload (192 bytes).
 *
 * The BPF object encodes these bytes (bpf/vigil.bpf.c); the daemon's index
 * renderer decodes them (src/index.c); the ctest suites hold both sides to
 * the layouts below. Every field is fixed-width little-endian unless noted;
 * strings are NUL-terminated prefixes (paths longer than the cap are cut,
 * never malformed).
 */
#ifndef VIG_PAYLOAD_H
#define VIG_PAYLOAD_H

#include <stdint.h>

/* payload capacity == struct vig_event.payload (event.h) */
#define VIG_PAYLOAD_MAX 192

/* OP_EXEC: NUL-terminated exe path (full path; empty when the record read
 * failed). OP_HEALTH: pre-rendered JSON fragment (src/health.c). */

/* OP_FILE_MUT — file mutations, from the file hooks (LSM primary, kprobe
 * fallback; both encode identically):
 *   [0]      action (enum vig_file_action)
 *   open:    [1..4] open flags, LE u32 (f_flags); [5..] path
 *   unlink / truncate: [1..] path
 *   rename:  [1..VIG_PATH_CAP]        old path
 *            [VIG_PATH_CAP+1..]       new path
 */
enum vig_file_action {
	VIG_FILE_OPEN_W = 1, /* open for write: write-mode access or TRUNC/APPEND */
	VIG_FILE_UNLINK = 2,
	VIG_FILE_RENAME = 3,
	VIG_FILE_TRUNC  = 4,
};

/* rename splits the payload in two halves, each a path prefix */
#define VIG_PATH_CAP 96

/* open flags (asm-generic values; vmlinux.h carries no O_* macros) */
#define VIG_O_ACCMODE 3
#define VIG_O_WRONLY  1
#define VIG_O_RDWR    2
#define VIG_O_TRUNC   0x200
#define VIG_O_APPEND  0x400

/* OP_NET_CONN — connect attempts (LSM socket_connect, kprobe fallback):
 *   [0..1]  family, LE u16 (kernel AF_* value)
 *   [2..3]  port, LE u16, host byte order
 *   [4..7]   ipv4: address, 4 bytes, network order
 *   [4..19]  ipv6: address, 16 bytes, network order
 *   [4..111] unix: NUL-terminated path
 * The hook runs before the operation connects, so the record is the
 * attempt — no result is known, and none is invented.
 *
 * OP_NET_LISTEN — binds and listens (LSM socket_bind/socket_listen and
 * their fallbacks): the same address layout behind an op byte:
 *   [0]     op (enum vig_net_op)
 *   [1..2]  family
 *   [3..4]  port
 *   [5..]   address
 */
enum vig_net_op {
	VIG_NET_BIND = 1,
	VIG_NET_LISTEN_OP = 2,
};

/* families the renderer understands (linux values, stable on x86-64) */
#define VIG_AF_UNIX  1
#define VIG_AF_INET  2
#define VIG_AF_INET6 10

/* OP_PRIV — privilege changes (LSM capset or its kprobe fallback, and the
 * commit_creds kprobe covering the setuid family):
 *   [0..3]   from euid, LE u32
 *   [4..7]   to euid, LE u32
 *   [8..15]  new permitted set, LE u64 — raw 8 bytes: kernel_cap_t is
 *            __u32 cap[2] on 6.1 and a u64 on 6.12, identical bit layout
 *   [16]     source (enum vig_priv_src)
 */
enum vig_priv_src {
	VIG_PRIV_CAPSET = 1,
	VIG_PRIV_CREDS = 2,
};

/* OP_MODULE — module loads/unloads (tracepoints module:module_load/free):
 *   [0]      op (enum vig_module_op)
 *   [1..]    module name, NUL-terminated
 */
enum vig_module_op {
	VIG_MODULE_LOAD = 1,
	VIG_MODULE_UNLOAD = 2,
};

#endif
