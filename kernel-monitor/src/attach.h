/* Selective attach: which mechanism serves each LSM-class hook.
 *
 * The planner is a pure function of the probe results (host-testable); the
 * daemon executes the plan against the loaded skeleton and re-routes a hook
 * to its kprobe twin if the primary attach fails at runtime. Degraded is a
 * first-class path: a fallback or a missing hook marks monitor.health
 * degraded and names what is missing.
 */
#ifndef VIG_ATTACH_H
#define VIG_ATTACH_H

#include <stdbool.h>
#include <stddef.h>

enum vig_hook_mode {
	VIG_HOOK_LSM = 1,     /* BPF LSM program is the primary */
	VIG_HOOK_FALLBACK,    /* LSM unavailable: attach the kprobe twin */
	VIG_HOOK_MISSING,     /* neither attached (runtime failure) */
};

/* one planned hook, in a fixed spec order */
struct vig_hook_plan {
	const char *hook;      /* hook name, e.g. "file_open" */
	const char *fb_sym;    /* kprobe twin symbol, e.g. "security_file_open" */
	enum vig_hook_mode mode;
};

#define VIG_LSM_HOOKS 8 /* file_open, unlink, rename, truncate, connect, bind, listen, capset */

struct vig_attach_plan {
	struct vig_hook_plan hooks[VIG_LSM_HOOKS];
	size_t hooks_n;
	bool lsm_class; /* BPF LSM attachable at all */
};

/* Pure decision from the probe result: lsm_ok means the BPF LSM program
 * type is supported AND "bpf" is active in the kernel's LSM list. */
void vig_attach_plan_build(bool lsm_ok, struct vig_attach_plan *out);

/* Does this hook state set constitute degraded mode? */
bool vig_hooks_degraded(const enum vig_hook_mode *states, size_t n);

#endif
