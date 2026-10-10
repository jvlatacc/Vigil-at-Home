#include "health.h"

#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

int vig_health_event(struct vig_event *out, uint64_t mono_ns,
		     uint32_t daemon_pid, uint64_t dropped_total,
		     const char *const *hooks, size_t hooks_n, bool degraded)
{
	memset(out, 0, sizeof(*out));
	out->kind = VIG_OP_HEALTH;
	out->mono_ns = mono_ns;
	out->tgid = daemon_pid;
	out->uid = 0;

	/* the daemon's own comm (truncated to TASK_COMM_LEN by the kernel) */
	if (prctl(PR_GET_NAME, out->comm, 0, 0, 0) != 0)
		strcpy(out->comm, "vigil-kernel-mo");

	/* Pre-render the kind-specific fields as a JSON fragment that
	 * vig_index_line splices in. Keep it valid even when the list exceeds
	 * the 192-byte payload: trim trailing entries, never emit a cut one. */
	size_t used = 0;
	int n = snprintf((char *)out->payload + used, sizeof(out->payload) - used,
			 "\"droppedTotal\":%llu,\"hooks\":[",
			 (unsigned long long)dropped_total);

	if (n < 0)
		return -1;
	used += (size_t)n;
	for (size_t i = 0; i < hooks_n; i++) {
		char one[256];

		n = snprintf(one, sizeof one, "%s\"%s\"", i ? "," : "", hooks[i]);
		if (n < 0 || used + (size_t)n + 24 >= sizeof(out->payload))
			break; /* room must remain for the tail below */
		memcpy((char *)out->payload + used, one, (size_t)n + 1);
		used += (size_t)n;
	}
	n = snprintf((char *)out->payload + used, sizeof(out->payload) - used,
		     "],\"degraded\":%s", degraded ? "true" : "false");
	if (n < 0)
		return -1;
	return 0;
}

int vig_health_dropped_total(const struct vig_event *e, uint64_t *out)
{
	/* the fragment always begins "droppedTotal":N,... (writer above) */
	static const char prefix[] = "\"droppedTotal\":";
	const uint8_t *p;

	if (memcmp(e->payload, prefix, sizeof prefix - 1) != 0)
		return -1;
	p = e->payload + sizeof prefix - 1;
	if (*p < '0' || *p > '9')
		return -1;
	uint64_t v = 0;

	while (*p >= '0' && *p <= '9') {
		v = v * 10 + (uint64_t)(*p - '0');
		p++;
	}
	*out = v;
	return 0;
}
