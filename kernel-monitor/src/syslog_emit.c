#include "syslog_emit.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include "index.h"
#include "util.h"

#define VIG_LINE_MAX 2048

struct vig_syslog {
	char path[108]; /* sun_path size */
	int fd;
	int send_fails;
	/* in-memory sink (path == NULL): owned copies, one per record */
	char **recorded;
	size_t recorded_n, recorded_cap;
};

struct vig_syslog *vig_syslog_open(const char *path)
{
	struct vig_syslog *s = calloc(1, sizeof(*s));

	if (!s)
		return NULL;
	if (path && strlen(path) >= sizeof(s->path)) {
		free(s);
		return NULL;
	}
	s->fd = -1;
	if (path)
		strcpy(s->path, path);
	return s;
}

void vig_syslog_close(struct vig_syslog *s)
{
	if (!s)
		return;
	if (s->fd >= 0)
		close(s->fd);
	for (size_t i = 0; i < s->recorded_n; i++)
		free(s->recorded[i]);
	free(s->recorded);
	free(s);
}

int vig_syslog_line(int pri, const char *msgid, const struct vig_event *e,
		    const struct timespec *wall, const char *hostname,
		    int procid, char *buf, size_t cap)
{
	char ts[64], msg[VIG_LINE_MAX];

	if (vig_iso8601_ms(wall, ts, sizeof ts) != 0)
		return -1;
	/* the body mirrors the index line exactly, by construction */
	if (vig_index_line(e, wall, msg, sizeof msg) < 0)
		return -1;

	/* SD params: kind, tgid, uid always; ppid when known; euid when it
	 * differs from uid — matching the spec's sample message. All values
	 * are internal names and numbers, but escape anyway. */
	char ppid_part[32] = "", euid_part[32] = "";

	if (e->ppid)
		snprintf(ppid_part, sizeof ppid_part, " ppid=\"%u\"", e->ppid);
	if (e->euid != e->uid)
		snprintf(euid_part, sizeof euid_part, " euid=\"%u\"", e->euid);

	char sd[256];
	char kind_esc[32];

	if (vig_json_escape(vig_kind_short(e->kind), kind_esc,
			    sizeof kind_esc) != 0)
		return -1;
	int n = snprintf(sd, sizeof sd, "[%s kind=\"%s\" tgid=\"%u\"%s uid=\"%u\"%s]",
			 VIG_SYSLOG_SD_ID, kind_esc, e->tgid, ppid_part, e->uid,
			 euid_part);

	if (n < 0 || (size_t)n >= sizeof sd)
		return -1;

	int out_n = snprintf(buf, cap, "<%d>1 %s %s %s %d %s %s %s", pri, ts,
			     hostname, VIG_SYSLOG_APP_NAME, procid, msgid, sd,
			     msg);

	/* a line that would not fit is refused — never emitted malformed */
	if (out_n < 0 || (size_t)out_n >= cap)
		return -1;
	return out_n;
}

static int sink_connect(struct vig_syslog *s)
{
	int fd = socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0);

	if (fd < 0)
		return -1;

	struct sockaddr_un addr;

	memset(&addr, 0, sizeof addr);
	addr.sun_family = AF_UNIX;
	strcpy(addr.sun_path, s->path);
	if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
		close(fd);
		return -1;
	}
	s->fd = fd;
	return 0;
}

static void sink_record(struct vig_syslog *s, const char *line)
{
	if (s->recorded_n == s->recorded_cap) {
		size_t cap = s->recorded_cap ? s->recorded_cap * 2 : 64;
		char **rec = realloc(s->recorded, cap * sizeof(*s->recorded));

		if (!rec)
			return;
		s->recorded = rec;
		s->recorded_cap = cap;
	}
	char *copy = strndup(line, VIG_LINE_MAX - 1);

	if (!copy)
		return;
	s->recorded[s->recorded_n++] = copy;
}

int vig_syslog_emit(struct vig_syslog *s, int pri, const char *msgid,
		    const struct vig_event *e, const struct timespec *wall,
		    const char *hostname)
{
	char line[VIG_LINE_MAX];

	if (vig_syslog_line(pri, msgid, e, wall, hostname, (int)getpid(), line,
			    sizeof line) < 0) {
		fprintf(stderr, "vigil-kernel-monitor: syslog line truncated, dropped\n");
		return -1;
	}

	if (s->path[0] == '\0') {
		sink_record(s, line);
		return 0;
	}

	if (s->fd < 0 && sink_connect(s) != 0) {
		s->send_fails++;
		return -1;
	}
	if (send(s->fd, line, strlen(line), MSG_DONTWAIT) < 0) {
		/* rsyslog briefly unavailable or its buffer full: drop the
		 * message (the index keeps it) and reconnect next time */
		s->send_fails++;
		if (s->send_fails % 100 == 1)
			fprintf(stderr, "vigil-kernel-monitor: syslog send failed %d times: %s\n",
				s->send_fails, strerror(errno));
		close(s->fd);
		s->fd = -1;
		return -1;
	}
	return 0;
}

const char *const *vig_syslog_recorded(const struct vig_syslog *s, size_t *n)
{
	*n = s->recorded_n;
	return (const char *const *)s->recorded;
}
