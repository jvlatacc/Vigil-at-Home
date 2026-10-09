#include "index.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "payload.h"
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

/* shared base: kind, source, wall clock, identity, lineage, comm — kinds
 * append their own fields before the closing brace */
static int render_base(const struct vig_event *e, const char *at, char *out,
		       size_t cap)
{
	char comm_esc[3 * 16 + 8];

	if (vig_json_escape(e->comm, comm_esc, sizeof comm_esc) != 0)
		return -1;
	return snprintf(out, cap,
			"{\"kind\":\"%s\",\"source\":\"kernel-monitor\","
			"\"at\":\"%s\",\"monoNs\":%llu,\"tgid\":%u,"
			"\"ppid\":%u,\"uid\":%u,\"euid\":%u,\"comm\":\"%s\"",
			vig_kind_json(e->kind), at,
			(unsigned long long)e->mono_ns, e->tgid, e->ppid,
			e->uid, e->euid, comm_esc);
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
		char exe[193], exe_esc[2 * 193 + 8], base[256];
		int nb;

		memcpy(exe, e->payload, 192);
		exe[192] = '\0';
		if (vig_json_escape(exe, exe_esc, sizeof exe_esc) != 0)
			return -1;
		nb = render_base(e, at, base, sizeof base);
		if (nb < 0 || (size_t)nb >= sizeof base)
			return -1;
		return snprintf(buf, cap, "%s,\"exe\":\"%s\"}", base, exe_esc);
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
	case VIG_OP_FILE_MUT: {
		/* payload per src/payload.h: open [0|flags 1..4|path 5..
		 * (≤187)], unlink/truncate [0|path 1.. (≤191)], rename
		 * [0|old 1..96 (≤95)|new 97..191 (≤94)] — unknown actions
		 * fail closed */
		char base[256], path[192], new_path[95], tail[560];
		char path_esc[2 * 192 + 8], new_esc[2 * 95 + 8];
		char *np_esc = NULL;
		uint32_t flags = 0;
		int nb, tb;

		switch (e->payload[0]) {
		case VIG_FILE_OPEN_W:
			memcpy(&flags, &e->payload[1], sizeof(flags));
			memcpy(path, &e->payload[5], 187);
			path[187] = '\0';
			break;
		case VIG_FILE_UNLINK:
		case VIG_FILE_TRUNC:
			memcpy(path, &e->payload[1], 191);
			path[191] = '\0';
			break;
		case VIG_FILE_RENAME:
			memcpy(path, &e->payload[1], 96);
			path[96] = '\0';
			memcpy(new_path, &e->payload[1 + VIG_PATH_CAP], 94);
			new_path[94] = '\0';
			np_esc = new_esc;
			break;
		default:
			return -1;
		}

		if (vig_json_escape(path, path_esc, sizeof path_esc) != 0)
			return -1;
		if (np_esc &&
		    vig_json_escape(new_path, np_esc, sizeof new_esc) != 0)
			return -1;

		nb = render_base(e, at, base, sizeof base);
		if (nb < 0 || (size_t)nb >= sizeof base)
			return -1;
		if (e->payload[0] == VIG_FILE_OPEN_W)
			tb = snprintf(tail, sizeof tail,
				      ",\"action\":\"open-w\",\"mode\":%u,"
				      "\"path\":\"%s\"}",
				      flags, path_esc);
		else if (e->payload[0] == VIG_FILE_RENAME)
			tb = snprintf(tail, sizeof tail,
				      ",\"action\":\"rename\",\"path\":\"%s\","
				      "\"newPath\":\"%s\"}",
				      path_esc, np_esc);
		else
			tb = snprintf(tail, sizeof tail,
				      ",\"action\":\"%s\",\"path\":\"%s\"}",
				      e->payload[0] == VIG_FILE_UNLINK ?
					      "unlink" :
					      "truncate",
				      path_esc);
		if (tb < 0)
			return -1;
		return snprintf(buf, cap, "%s%s", base, tail);
	}
	case VIG_OP_NET_CONN:
	case VIG_OP_NET_LISTEN: {
		/* connections have no op byte: family at [4..5], port
		 * [6..7], address [8..]; binds/listens are the same
		 * layout behind an op byte at [0] */
		char base[256], astr[128], astr_esc[2 * 128 + 8], tail[224];
		const uint8_t *ab;
		uint16_t fam, port;
		int fam_off = e->kind == VIG_OP_NET_CONN ? 4 : 1;
		int nb, tb;

		memcpy(&fam, &e->payload[fam_off], sizeof(fam));
		memcpy(&port, &e->payload[fam_off + 2], sizeof(port));
		ab = &e->payload[fam_off + 4];
		if (fam == VIG_AF_INET)
			snprintf(astr, sizeof astr, "%u.%u.%u.%u", ab[0],
				 ab[1], ab[2], ab[3]);
		else if (fam == VIG_AF_INET6)
			snprintf(astr, sizeof astr,
				 "%x:%x:%x:%x:%x:%x:%x:%x",
				 (ab[0] << 8) | ab[1], (ab[2] << 8) | ab[3],
				 (ab[4] << 8) | ab[5], (ab[6] << 8) | ab[7],
				 (ab[8] << 8) | ab[9],
				 (ab[10] << 8) | ab[11],
				 (ab[12] << 8) | ab[13],
				 (ab[14] << 8) | ab[15]);
		else if (fam == VIG_AF_UNIX) {
			memcpy(astr, ab, 104);
			astr[104] = '\0';
		} else
			astr[0] = '\0'; /* unknown family: no guess */

		if (vig_json_escape(astr, astr_esc, sizeof astr_esc) != 0)
			return -1;
		nb = render_base(e, at, base, sizeof base);
		if (nb < 0 || (size_t)nb >= sizeof base)
			return -1;
		tb = snprintf(tail, sizeof tail,
			      ",\"family\":%u,\"address\":\"%s\",\"port\":%u}",
			      fam, astr_esc, port);
		if (tb < 0)
			return -1;
		return snprintf(buf, cap, "%s%s", base, tail);
	}
	case VIG_OP_PRIV: {
		/* [0..3] from euid, [4..7] to euid, [8..15] new permitted
		 * set as a raw mask, [16] source hook */
		char base[256], tail[128];
		uint32_t from, to;
		uint64_t caps;
		int nb, tb;

		memcpy(&from, &e->payload[0], sizeof(from));
		memcpy(&to, &e->payload[4], sizeof(to));
		memcpy(&caps, &e->payload[8], sizeof(caps));
		nb = render_base(e, at, base, sizeof base);
		if (nb < 0 || (size_t)nb >= sizeof base)
			return -1;
		tb = snprintf(tail, sizeof tail,
			      ",\"fromUid\":%u,\"toUid\":%u,\"caps\":\"0x%llx\"}",
			      from, to, (unsigned long long)caps);
		if (tb < 0)
			return -1;
		return snprintf(buf, cap, "%s%s", base, tail);
	}
	case VIG_OP_MODULE: {
		/* [0] op, [1..] module name */
		char base[256], name[192], name_esc[2 * 192 + 8], tail[64];
		int nb, tb;

		memcpy(name, &e->payload[1], 191);
		name[191] = '\0';
		if (vig_json_escape(name, name_esc, sizeof name_esc) != 0)
			return -1;
		nb = render_base(e, at, base, sizeof base);
		if (nb < 0 || (size_t)nb >= sizeof base)
			return -1;
		tb = snprintf(tail, sizeof tail,
			      ",\"op\":\"%s\",\"module\":\"%s\"}",
			      e->payload[0] == VIG_MODULE_LOAD ? "load" :
								 "unload",
			      name_esc);
		if (tb < 0)
			return -1;
		return snprintf(buf, cap, "%s%s", base, tail);
	}
	default:
		return -1; /* kinds land with their hook PRs; never guess */
	}
}
