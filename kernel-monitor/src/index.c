#include "index.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "util.h"

struct vig_index {
	char base_path[PATH_MAX];
	uint64_t max_bytes;
	int keep;
	int fd;
	uint64_t size;
};

struct vig_index *vig_index_open(const char *dir, const char *base,
				 uint64_t max_bytes, int keep)
{
	struct vig_index *ix = calloc(1, sizeof(*ix));

	if (!ix)
		return NULL;
	if (keep < 1)
		keep = 1;
	ix->max_bytes = max_bytes;
	ix->keep = keep;

	int n = snprintf(ix->base_path, sizeof(ix->base_path), "%s/%s", dir,
			 base);

	/* leave room for rotation suffixes so they can never truncate */
	if (n < 0 || (size_t)n >= sizeof(ix->base_path) - 16) {
		free(ix);
		return NULL;
	}

	ix->fd = open(ix->base_path, O_WRONLY | O_CREAT | O_APPEND, 0600);
	if (ix->fd < 0) {
		free(ix);
		return NULL;
	}

	struct stat st;

	if (fstat(ix->fd, &st) == 0)
		ix->size = (uint64_t)st.st_size;
	return ix;
}

static int rotate(struct vig_index *ix)
{
	char from[PATH_MAX], to[PATH_MAX];

	close(ix->fd);
	for (int i = ix->keep - 1; i >= 1; i--) {
		/* open() guaranteed base_path + suffix fits; verify anyway and
		 * fail loudly rather than rename into a truncated name */
		int nf = snprintf(from, sizeof from, "%s.%d", ix->base_path, i);
		int nt = snprintf(to, sizeof to, "%s.%d", ix->base_path, i + 1);

		if (nf < 0 || nt < 0 || (size_t)nf >= sizeof from ||
		    (size_t)nt >= sizeof to)
			return -1;
		/* a missing slot just means the run has not rotated that far */
		rename(from, to);
	}
	int nt = snprintf(to, sizeof to, "%s.1", ix->base_path);

	if (nt < 0 || (size_t)nt >= sizeof to)
		return -1;
	rename(ix->base_path, to);

	ix->fd = open(ix->base_path, O_WRONLY | O_CREAT | O_APPEND, 0600);
	ix->size = 0;
	return ix->fd >= 0 ? 0 : -1;
}

static int write_all(int fd, const char *buf, size_t len)
{
	while (len > 0) {
		ssize_t w = write(fd, buf, len);

		if (w < 0) {
			if (errno == EINTR)
				continue;
			return -1;
		}
		buf += w;
		len -= (size_t)w;
	}
	return 0;
}

int vig_index_append(struct vig_index *ix, const char *line)
{
	size_t len = strlen(line);

	if (ix->size > 0 && ix->size + len + 1 > ix->max_bytes &&
	    rotate(ix) != 0)
		return -1;

	if (write_all(ix->fd, line, len) != 0 || write_all(ix->fd, "\n", 1) != 0)
		return -1;
	ix->size += len + 1;
	return 0;
}

void vig_index_close(struct vig_index *ix)
{
	if (!ix)
		return;
	if (ix->fd >= 0)
		close(ix->fd);
	free(ix);
}

int vig_index_line(const struct vig_event *e, const struct timespec *wall,
		   char *buf, size_t cap)
{
	char at[64];

	if (vig_iso8601_ms(wall, at, sizeof at) != 0)
		return -1;

	char comm_esc[3 * 16 + 8];

	if (vig_json_escape(e->comm, comm_esc, sizeof comm_esc) != 0)
		return -1;

	switch (e->kind) {
	case VIG_OP_EXEC: {
		/* payload carries an NUL-terminated exe prefix; force
		 * termination in case a future hook fills all 192 bytes */
		char exe[193], exe_esc[2 * 193 + 8];

		memcpy(exe, e->payload, 192);
		exe[192] = '\0';
		if (vig_json_escape(exe, exe_esc, sizeof exe_esc) != 0)
			return -1;
		return snprintf(buf, cap,
				"{\"kind\":\"%s\",\"source\":\"kernel-monitor\","
				"\"at\":\"%s\",\"monoNs\":%llu,\"tgid\":%u,"
				"\"ppid\":%u,\"uid\":%u,\"euid\":%u,"
				"\"comm\":\"%s\",\"exe\":\"%s\"}",
				vig_kind_json(e->kind), at,
				(unsigned long long)e->mono_ns, e->tgid,
				e->ppid, e->uid, e->euid, comm_esc, exe_esc);
	}
	case VIG_OP_HEALTH: {
		/* payload carries a pre-rendered JSON fragment (built by
		 * vig_health_event): "droppedTotal":N,"hooks":[...],"degraded":b */
		char frag[193];

		memcpy(frag, e->payload, 192);
		frag[192] = '\0';
		return snprintf(buf, cap,
				"{\"kind\":\"%s\",\"source\":\"kernel-monitor\","
				"\"at\":\"%s\",\"monoNs\":%llu,\"tgid\":%u,"
				"\"uid\":0,\"comm\":\"%s\",%s}",
				vig_kind_json(e->kind), at,
				(unsigned long long)e->mono_ns, e->tgid,
				comm_esc, frag);
	}
	default:
		return -1; /* kinds land with their hook PRs; never guess */
	}
}
