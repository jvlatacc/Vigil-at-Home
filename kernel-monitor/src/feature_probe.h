/* Runtime feature probe: what this kernel can actually do. The daemon never
 * guesses — BTF presence gates startup entirely (CO-RE cannot relocate
 * without it), and every probe result rides the monitor.health line. */
#ifndef VIG_FEATURES_H
#define VIG_FEATURES_H

#include <stdbool.h>

struct vig_features {
	char kernel_release[65]; /* uname -r */
	bool btf_present;	 /* /sys/kernel/btf/vmlinux readable */
	bool ringbuf;		 /* kernel 5.8+: BPF_MAP_TYPE_RINGBUF */
	bool lsm_prog_supported; /* kernel knows BPF_PROG_TYPE_LSM */
	bool lsm_bpf_active;	 /* "bpf" in the active LSM list */
	bool kprobe_multi;	 /* kernel 5.18+: BPF_LINK_TYPE_KPROBE_MULTI */
};

int vig_features_probe(struct vig_features *out);

#endif
