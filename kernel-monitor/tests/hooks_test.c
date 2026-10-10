/* Hook paths: every fixture scenario encodes the payload bytes the BPF
 * object writes (src/payload.h), renders the index line, and asserts each
 * field round-trips — plus the syslog body, which must mirror the index
 * line by construction. Host-runnable: no kernel, no attach. */
#include "test_harness.h"

#include "../src/event.h"
#include "../src/index.h"
#include "../src/payload.h"
#include "../src/syslog_emit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef FIXTURES_DIR
#define FIXTURES_DIR "tests/fixtures"
#endif

#define HOOKS_LINE_MAX 2048

/* --- flat JSON reader: exact "key":value spans, strings unquoted --- */

static int jstr(const char *line, const char *key, char *out, size_t cap)
{
	char pat[48];

	snprintf(pat, sizeof pat, "\"%s\":", key);
	const char *p = strstr(line, pat);

	if (!p)
		return 0; /* absent */
	p += strlen(pat);
	while (*p == ' ')
		p++;
	if (*p != '"')
		return 0;
	p++;
	size_t o = 0;

	while (*p && *p != '"') {
		if (o + 1 < cap)
			out[o++] = *p;
		p++;
	}
	out[o] = '\0';
	return 1;
}

static int jnum(const char *line, const char *key, long long *out)
{
	char pat[48];

	snprintf(pat, sizeof pat, "\"%s\":", key);
	const char *p = strstr(line, pat);

	if (!p)
		return 0;
	p += strlen(pat);
	while (*p == ' ')
		p++;
	*out = strtoll(p, NULL, 10);
	return 1;
}

/* the rendered line must contain "key":<num-or-string> as a complete
 * field (a trailing delimiter rules out prefix matches) */
static int has_num(const char *line, const char *key, const char *numtext)
{
	char pat[128];
	int len;

	len = snprintf(pat, sizeof pat, "\"%s\":%s", key, numtext);
	const char *p = strstr(line, pat);

	return p && (p[len] == ',' || p[len] == '}');
}

static int has_str(const char *line, const char *key, const char *val)
{
	char pat[600];

	snprintf(pat, sizeof pat, "\"%s\":\"%s\"", key, val);
	return strstr(line, pat) != NULL;
}

/* --- fixture record --- */

struct hrec {
	char kind[32], action[16], op[8], addr[128], addr_hex[36], module[64];
	char caps[24], src[12], comm[16];
	long long flags, family, port, from_uid, to_uid;
	long long mono_ns, tgid, ppid, uid, euid;
	char path[512], new_path[512];
};

static void hrec_defaults(struct hrec *r)
{
	memset(r, 0, sizeof *r);
	r->mono_ns = 1000;
	r->tgid = 100;
	r->ppid = 10;
	r->uid = 1000;
	r->euid = 1000;
	strcpy(r->comm, "sh");
}

static int parse_fixture_line(const char *line, struct hrec *r)
{
	hrec_defaults(r);
	jstr(line, "kind", r->kind, sizeof r->kind);
	jstr(line, "action", r->action, sizeof r->action);
	jstr(line, "op", r->op, sizeof r->op);
	jstr(line, "addr", r->addr, sizeof r->addr);
	jstr(line, "addrHex", r->addr_hex, sizeof r->addr_hex);
	jstr(line, "module", r->module, sizeof r->module);
	jstr(line, "caps", r->caps, sizeof r->caps);
	jstr(line, "src", r->src, sizeof r->src);
	jstr(line, "comm", r->comm, sizeof r->comm);
	jstr(line, "path", r->path, sizeof r->path);
	jstr(line, "newPath", r->new_path, sizeof r->new_path);
	jnum(line, "flags", &r->flags);
	jnum(line, "family", &r->family);
	jnum(line, "port", &r->port);
	jnum(line, "fromUid", &r->from_uid);
	jnum(line, "toUid", &r->to_uid);
	jnum(line, "monoNs", &r->mono_ns);
	jnum(line, "tgid", &r->tgid);
	jnum(line, "ppid", &r->ppid);
	jnum(line, "uid", &r->uid);
	jnum(line, "euid", &r->euid);
	return r->kind[0] ? 0 : -1;
}

/* --- encoder: fixture fields → payload bytes, mirroring the BPF --- */

static void put_le16(uint8_t *p, unsigned long v)
{
	p[0] = (uint8_t)(v & 0xff);
	p[1] = (uint8_t)((v >> 8) & 0xff);
}

static void put_le32(uint8_t *p, unsigned long v)
{
	put_le16(p, v & 0xffff);
	put_le16(p + 2, (v >> 16) & 0xffff);
}

static void put_le64(uint8_t *p, unsigned long long v)
{
	put_le32(p, (unsigned long)(v & 0xffffffff));
	put_le32(p + 4, (unsigned long)(v >> 32));
}

static void copy_str(uint8_t *dst, const char *src, size_t cap)
{
	size_t n = strlen(src);

	/* cap is NUL-inclusive, matching the BPF compose bounds */
	if (n > cap - 1)
		n = cap - 1;
	memcpy(dst, src, n);
	dst[n] = '\0';
}

static int encode(const struct hrec *r, struct vig_event *e)
{
	memset(e, 0, sizeof *e);

	if (!strcmp(r->kind, "file")) {
		e->kind = VIG_OP_FILE_MUT;
		if (!strcmp(r->action, "open-w")) {
			e->payload[0] = VIG_FILE_OPEN_W;
			put_le32(&e->payload[1], (unsigned long)r->flags);
			copy_str(&e->payload[5], r->path, 187);
		} else if (!strcmp(r->action, "unlink")) {
			e->payload[0] = VIG_FILE_UNLINK;
			copy_str(&e->payload[1], r->path, 191);
		} else if (!strcmp(r->action, "truncate")) {
			e->payload[0] = VIG_FILE_TRUNC;
			copy_str(&e->payload[1], r->path, 191);
		} else if (!strcmp(r->action, "rename")) {
			e->payload[0] = VIG_FILE_RENAME;
			copy_str(&e->payload[1], r->path, VIG_PATH_CAP);
			copy_str(&e->payload[1 + VIG_PATH_CAP], r->new_path,
				 95);
		} else
			return -1;
	} else if (!strcmp(r->kind, "network.connection")) {
		e->kind = VIG_OP_NET_CONN;
		put_le16(&e->payload[4], (unsigned long)r->family);
		put_le16(&e->payload[6], (unsigned long)r->port);
		if (r->family == 2 && r->addr[0]) {
			unsigned a, b, c, d;

			sscanf(r->addr, "%u.%u.%u.%u", &a, &b, &c, &d);
			e->payload[8] = (uint8_t)a;
			e->payload[9] = (uint8_t)b;
			e->payload[10] = (uint8_t)c;
			e->payload[11] = (uint8_t)d;
		} else if (r->family == 10 && r->addr_hex[0]) {
			for (int i = 0; i < 16; i++) {
				char byte[3] = { r->addr_hex[2 * i],
						 r->addr_hex[2 * i + 1], 0 };

				e->payload[8 + i] =
					(uint8_t)strtoul(byte, NULL, 16);
			}
		} else if (r->family == 1 && r->addr[0]) {
			copy_str(&e->payload[8], r->addr, 103);
		}
	} else if (!strcmp(r->kind, "network.listen")) {
		e->kind = VIG_OP_NET_LISTEN;
		e->payload[0] = !strcmp(r->op, "bind") ?
				       VIG_NET_BIND :
				       VIG_NET_LISTEN_OP;
		put_le16(&e->payload[1], (unsigned long)r->family);
		put_le16(&e->payload[3], (unsigned long)r->port);
		if (r->family == 2 && r->addr[0]) {
			unsigned a, b, c, d;

			sscanf(r->addr, "%u.%u.%u.%u", &a, &b, &c, &d);
			e->payload[5] = (uint8_t)a;
			e->payload[6] = (uint8_t)b;
			e->payload[7] = (uint8_t)c;
			e->payload[8] = (uint8_t)d;
		} else if (r->family == 10 && r->addr_hex[0]) {
			for (int i = 0; i < 16; i++) {
				char byte[3] = { r->addr_hex[2 * i],
						 r->addr_hex[2 * i + 1], 0 };

				e->payload[5 + i] =
					(uint8_t)strtoul(byte, NULL, 16);
			}
		}
	} else if (!strcmp(r->kind, "privilege.change")) {
		e->kind = VIG_OP_PRIV;
		put_le32(&e->payload[0], (unsigned long)r->from_uid);
		put_le32(&e->payload[4], (unsigned long)r->to_uid);
		put_le64(&e->payload[8], strtoull(r->caps, NULL, 16));
		e->payload[16] = (uint8_t)(!strcmp(r->src, "capset") ?
						   VIG_PRIV_CAPSET :
						   VIG_PRIV_CREDS);
	} else if (!strcmp(r->kind, "kernel.module")) {
		e->kind = VIG_OP_MODULE;
		e->payload[0] = !strcmp(r->op, "load") ?
					VIG_MODULE_LOAD :
					VIG_MODULE_UNLOAD;
		copy_str(&e->payload[1], r->module, 191);
	} else
		return -1;

	e->mono_ns = (uint64_t)r->mono_ns;
	e->tgid = (uint32_t)r->tgid;
	e->ppid = (uint32_t)r->ppid;
	e->uid = (uint32_t)r->uid;
	e->euid = (uint32_t)r->euid;
	strcpy(e->comm, r->comm);
	return 0;
}

/* --- assertions per kind --- */

static char numbuf[24];

static const char *num(long long v)
{
	snprintf(numbuf, sizeof numbuf, "%lld", v);
	return numbuf;
}

static void check_scenario(const struct hrec *r, const char *line)
{
	CHECK(has_str(line, "kind", r->kind));
	CHECK(has_num(line, "monoNs", num(r->mono_ns)));
	CHECK(has_num(line, "tgid", num(r->tgid)));
	CHECK(has_num(line, "ppid", num(r->ppid)));
	CHECK(has_num(line, "uid", num(r->uid)));
	CHECK(has_num(line, "euid", num(r->euid)));
	CHECK(has_str(line, "comm", r->comm));
	CHECK(has_str(line, "source", "kernel-monitor"));
	CHECK(has_str(line, "at", "1970-01-01T00:00:00.000Z"));

	if (!strcmp(r->kind, "file")) {
		CHECK(has_str(line, "action", r->action));
		CHECK(has_str(line, "path", r->path));
		if (!strcmp(r->action, "open-w"))
			CHECK(has_num(line, "mode", num(r->flags)));
		if (!strcmp(r->action, "rename"))
			CHECK(has_str(line, "newPath", r->new_path));
	} else if (!strcmp(r->kind, "network.connection") ||
		   !strcmp(r->kind, "network.listen")) {
		CHECK(has_num(line, "family", num(r->family)));
		/* the port field always renders (0 for unix and unknown
		 * families, where no port was encoded) */
		CHECK(has_num(line, "port", num(r->port)));
		if (r->addr[0])
			CHECK(has_str(line, "address", r->addr));
		else if (!r->addr_hex[0])
			CHECK(has_str(line, "address", ""));
		if (r->addr_hex[0] && r->family == 10) {
			/* full-form IPv6 rendered from the 16 bytes */
			char expect[64];
			const char *h = r->addr_hex;
			unsigned g[8];

			for (int i = 0; i < 8; i++) {
				char grp[5] = { h[4 * i], h[4 * i + 1],
						h[4 * i + 2], h[4 * i + 3], 0 };

				g[i] = strtoul(grp, NULL, 16);
			}
			snprintf(expect, sizeof expect,
				 "\"address\":\"%x:%x:%x:%x:%x:%x:%x:%x\"",
				 g[0], g[1], g[2], g[3], g[4], g[5], g[6],
				 g[7]);
			CHECK(strstr(line, expect) != NULL);
		}
	} else if (!strcmp(r->kind, "privilege.change")) {
		CHECK(has_num(line, "fromUid", num(r->from_uid)));
		CHECK(has_num(line, "toUid", num(r->to_uid)));
		CHECK(has_str(line, "caps", r->caps));
	} else if (!strcmp(r->kind, "kernel.module")) {
		CHECK(has_str(line, "op", r->op));
		CHECK(has_str(line, "module", r->module));
	}
}

int main(void)
{
	/* every fixture scenario: encode → render → fields round-trip,
	 * and the syslog body carries the index line verbatim */
	const char *fixture_path = FIXTURES_DIR "/hooks.jsonl";
	FILE *f = fopen(fixture_path, "r");

	CHECK(f != NULL);

	char raw[1024];
	int scenarios = 0;
	const struct timespec epoch = { 0, 0 };

	while (fgets(raw, sizeof raw, f)) {
		if (raw[strspn(raw, " \t\r\n")] == '\0')
			continue;
		struct hrec r;
		struct vig_event e;
		char line[HOOKS_LINE_MAX], sys[HOOKS_LINE_MAX * 2];

		CHECK(parse_fixture_line(raw, &r) == 0);
		CHECK(encode(&r, &e) == 0);
		CHECK(vig_index_line(&e, &epoch, line, sizeof line) > 0);
		check_scenario(&r, line);
		CHECK(vig_syslog_line(34, "VIGOP", &e, &epoch, "laptop01",
				      1421, sys, sizeof sys) > 0);
		CHECK(strstr(sys, line) != NULL);
		scenarios++;
	}
	fclose(f);
	CHECK(scenarios == 18); /* every fixture line exercised */

	/* --- fail-closed checks: unknown bytes never render guesses --- */
	struct vig_event e;
	const struct timespec wall = { 0, 0 };
	char line[HOOKS_LINE_MAX];

	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_FILE_MUT;
	e.payload[0] = 0x7f; /* not a defined file action */
	CHECK(vig_index_line(&e, &wall, line, sizeof line) < 0);

	e.kind = (enum vig_kind)200;
	CHECK(vig_index_line(&e, &wall, line, sizeof line) < 0);

	/* --- exec full path: the PR #18 deviation fix, pinned here --- */
	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_EXEC;
	e.mono_ns = 9000000000;
	e.tgid = 20531;
	e.ppid = 20510;
	e.uid = 1000;
	e.euid = 1000;
	strcpy(e.comm, "sh");
	strcpy((char *)e.payload, "/usr/bin/curl");
	CHECK(vig_index_line(&e, &wall, line, sizeof line) > 0);
	CHECK(has_str(line, "exe", "/usr/bin/curl"));
	CHECK(!strstr(line, "\"exe\":\"sh\""));

	/* --- exec with a path filling the whole payload: the renderer
	 * forces termination and emits valid JSON --- */
	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_EXEC;
	strcpy(e.comm, "sh");
	char longpath[300];

	memset(longpath, 'x', sizeof longpath - 1);
	longpath[0] = '/';
	longpath[sizeof longpath - 1] = '\0';
	memcpy(e.payload, longpath, 192); /* a full 192-byte prefix */
	CHECK(vig_index_line(&e, &wall, line, sizeof line) > 0);
	CHECK(strlen(line) > 192);
	CHECK(strchr(line, '}') != NULL);

	/* --- file open path at the BPF compose cap (187): rendered whole --- */
	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_FILE_MUT;
	e.payload[0] = VIG_FILE_OPEN_W;
	put_le32(&e.payload[1], 577);
	memset(longpath, 'y', sizeof longpath - 1);
	longpath[0] = '/';
	longpath[188] = '\0'; /* 188 chars total: at the cap */
	copy_str(&e.payload[5], longpath, 187);
	CHECK(vig_index_line(&e, &wall, line, sizeof line) > 0);
	CHECK(strstr(line, "yyyy") != NULL);
	CHECK(has_num(line, "mode", "577"));

	/* --- empty exe payload renders an empty string, not garbage --- */
	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_EXEC;
	strcpy(e.comm, "sh");
	CHECK(vig_index_line(&e, &wall, line, sizeof line) > 0);
	CHECK(has_str(line, "exe", ""));

	TEST_END();
}
