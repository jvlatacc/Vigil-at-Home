/* Userspace mirror of the BPF-side ring-buffer record (bpf/vigil.bpf.c).
 * The daemon receives raw ring-buffer bytes; keeping this struct bit-identical
 * to the BPF side is the whole contract, so it is checked at compile time. */
#ifndef VIG_EVENT_H
#define VIG_EVENT_H

#include <stddef.h>
#include <stdint.h>

enum vig_kind {
	VIG_OP_EXEC = 1,
	VIG_OP_FORK,
	VIG_OP_FILE_MUT,
	VIG_OP_NET_CONN,
	VIG_OP_NET_LISTEN,
	VIG_OP_PRIV,
	VIG_OP_MODULE,
	VIG_OP_HEALTH,
};

struct vig_event {
	uint64_t mono_ns;  /* bpf_ktime_get_ns() — the ordering key */
	uint32_t kind, tgid, ppid, uid, euid;
	int64_t ret;
	char comm[16];
	uint8_t payload[192]; /* exe prefix for exec; JSON fragment for health */
};

/* Layout mirror of __u64/__u32/__s64/char[16]/__u8[192] on x86-64. */
_Static_assert(sizeof(struct vig_event) == 248,
	       "vig_event must match the BPF-side struct");

/* Short name used in syslog structured data ("exec", "health", ...). */
const char *vig_kind_short(uint32_t kind);

/* JSON kind string used in index lines and the syslog JSON body
 * ("process.exec", "monitor.health") — matches packages/core/src/event.ts. */
const char *vig_kind_json(uint32_t kind);

#endif
