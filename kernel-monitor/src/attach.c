#include "attach.h"

/* Fixed order so the health line names hooks the same way on every run. */
static const struct vig_hook_plan spec_hooks[VIG_LSM_HOOKS] = {
	{ "file_open", "security_file_open", VIG_HOOK_LSM },
	{ "inode_unlink", "security_inode_unlink", VIG_HOOK_LSM },
	{ "inode_rename", "security_inode_rename", VIG_HOOK_LSM },
	{ "file_truncate", "security_file_truncate", VIG_HOOK_LSM },
	{ "socket_connect", "security_socket_connect", VIG_HOOK_LSM },
	{ "socket_bind", "security_socket_bind", VIG_HOOK_LSM },
	{ "socket_listen", "security_socket_listen", VIG_HOOK_LSM },
	{ "capset", "security_capset", VIG_HOOK_LSM },
};

void vig_attach_plan_build(bool lsm_ok, struct vig_attach_plan *out)
{
	size_t i;

	out->hooks_n = VIG_LSM_HOOKS;
	out->lsm_class = lsm_ok;
	for (i = 0; i < VIG_LSM_HOOKS; i++) {
		out->hooks[i] = spec_hooks[i];
		out->hooks[i].mode = lsm_ok ? VIG_HOOK_LSM : VIG_HOOK_FALLBACK;
	}
}

bool vig_hooks_degraded(const enum vig_hook_mode *states, size_t n)
{
	size_t i;

	for (i = 0; i < n; i++) {
		if (states[i] != VIG_HOOK_LSM)
			return true;
	}
	return false;
}
