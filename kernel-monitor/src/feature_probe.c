#include "feature_probe.h"

#include <bpf/libbpf.h>
#include <stdio.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

static int parse_kernel_version(const char *release, int *maj, int *min)
{
	if (sscanf(release, "%d.%d", maj, min) != 2)
		return -1;
	return 0;
}

static bool lsm_list_contains(const char *want)
{
	FILE *fp = fopen("/sys/kernel/security/lsm", "r");

	if (!fp)
		return false;

	char line[256];
	bool found = false;

	if (fgets(line, sizeof line, fp)) {
		for (char *tok = strtok(line, " \t\n"); tok;
		     tok = strtok(NULL, " \t\n")) {
			if (strcmp(tok, want) == 0) {
				found = true;
				break;
			}
		}
	}
	fclose(fp);
	return found;
}

int vig_features_probe(struct vig_features *out)
{
	memset(out, 0, sizeof(*out));

	struct utsname u;
	int maj = 0, min = 0;

	if (uname(&u) == 0) {
		snprintf(out->kernel_release, sizeof(out->kernel_release), "%s",
			 u.release);
		parse_kernel_version(u.release, &maj, &min);
		out->ringbuf = maj > 5 || (maj == 5 && min >= 8);
	}

	out->btf_present = access("/sys/kernel/btf/vmlinux", R_OK) == 0;
	out->lsm_prog_supported =
		libbpf_probe_bpf_prog_type(BPF_PROG_TYPE_LSM, NULL) == 1;
	out->lsm_bpf_active = lsm_list_contains("bpf");
	/* kprobe-multi has no probe API in libbpf 1.5 (link-type probing is
	 * newer); it shipped in kernel 5.18, so gate on the release. The
	 * attach attempt at load time stays authoritative — failure falls
	 * back to per-program kprobe attach and the health line names it. */
	out->kprobe_multi = maj >= 6 || (maj == 5 && min >= 18);
	return 0;
}
