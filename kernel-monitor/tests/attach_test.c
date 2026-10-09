/* The attach planner: pure decision from the probe results. The LSM hook
 * set, its order, and the degraded composition are contract — the daemon's
 * executor and the health line both depend on them. */
#include "test_harness.h"

#include "../src/attach.h"

#include <string.h>

int main(void)
{
	struct vig_attach_plan plan;

	/* full LSM support: every hook on its primary mechanism, in spec
	 * order, nothing degraded */
	vig_attach_plan_build(true, &plan);
	CHECK(plan.hooks_n == 8);
	CHECK(plan.lsm_class == true);
	CHECK(strcmp(plan.hooks[0].hook, "file_open") == 0);
	CHECK(strcmp(plan.hooks[1].hook, "inode_unlink") == 0);
	CHECK(strcmp(plan.hooks[2].hook, "inode_rename") == 0);
	CHECK(strcmp(plan.hooks[3].hook, "file_truncate") == 0);
	CHECK(strcmp(plan.hooks[4].hook, "socket_connect") == 0);
	CHECK(strcmp(plan.hooks[5].hook, "socket_bind") == 0);
	CHECK(strcmp(plan.hooks[6].hook, "socket_listen") == 0);
	CHECK(strcmp(plan.hooks[7].hook, "capset") == 0);
	for (size_t i = 0; i < plan.hooks_n; i++) {
		CHECK(plan.hooks[i].mode == VIG_HOOK_LSM);
		/* every hook names its kprobe twin even when unused */
		CHECK(strncmp(plan.hooks[i].fb_sym, "security_", 9) == 0);
	}

	/* BPF LSM supported but not active (no lsm= cmdline entry): every
	 * hook falls back, and the fallback symbols match the LSM hook */
	vig_attach_plan_build(false, &plan);
	CHECK(plan.hooks_n == 8);
	CHECK(plan.lsm_class == false);
	for (size_t i = 0; i < plan.hooks_n; i++)
		CHECK(plan.hooks[i].mode == VIG_HOOK_FALLBACK);
	CHECK(strcmp(plan.hooks[0].fb_sym, "security_file_open") == 0);
	CHECK(strcmp(plan.hooks[7].fb_sym, "security_capset") == 0);

	/* degraded composition: any non-primary hook state degrades */
	CHECK(vig_hooks_degraded((enum vig_hook_mode[]){ VIG_HOOK_LSM,
							 VIG_HOOK_LSM },
				 2) == false);
	CHECK(vig_hooks_degraded((enum vig_hook_mode[]){ VIG_HOOK_LSM,
							 VIG_HOOK_FALLBACK },
				 2) == true);
	CHECK(vig_hooks_degraded((enum vig_hook_mode[]){ VIG_HOOK_MISSING },
				 1) == true);
	CHECK(vig_hooks_degraded(NULL, 0) == false);

	return 0;
}
