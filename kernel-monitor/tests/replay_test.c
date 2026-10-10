/* Record/replay: feed a captured fixture (deliberately out-of-order stamps,
 * as ring-buffer drains across CPUs produce) through the pipeline and assert
 * the emitted index lines and syslog messages are monotonic and grammatical.
 * The malformed fixture must be rejected, never emitted. */
#include "test_harness.h"

#include "../src/index.h"
#include "../src/pipeline.h"
#include "../src/syslog_emit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef FIXTURES_DIR
#define FIXTURES_DIR "tests/fixtures"
#endif

struct fake_clock {
	uint64_t mono_ns;
	struct timespec wall;
};

static uint64_t fake_mono(void *ctx)
{
	return ((struct fake_clock *)ctx)->mono_ns;
}

static struct timespec fake_wall(void *ctx)
{
	return ((struct fake_clock *)ctx)->wall;
}

/* Fixture reader: flat JSON with string/number values, no nesting. The app's
 * zod parser is the strict consumer; this loader only needs the fields the
 * core understands, and must reject broken lines rather than guess. */
static int parse_fixture_line(const char *line, struct vig_event *e,
			      char *exe, size_t exe_cap)
{
	memset(e, 0, sizeof *e);
	e->kind = VIG_OP_EXEC; /* fixtures are captured exec records */

	int fields = 0;
	const char *p = line;

	while (*p == ' ' || *p == '{')
		p++; /* flat JSON object: step past the opening brace */
	while (*p) {
		const char *key;
		size_t klen;

		if (*p != '"')
			break;
		key = ++p;
		while (*p && *p != '"')
			p++;
		if (*p != '"')
			return -1;
		klen = (size_t)(p - key);
		p++; /* closing quote */
		while (*p == ' ' || *p == ':')
			p++;

		char kbuf[32];

		if (klen >= sizeof kbuf)
			return -1;
		memcpy(kbuf, key, klen);
		kbuf[klen] = '\0';

		if (!strcmp(kbuf, "exe")) {
			if (*p != '"')
				return -1;
			const char *v = ++p;

			while (*p && *p != '"')
				p++;
			if (*p != '"')
				return -1;
			if ((size_t)(p - v) >= exe_cap)
				return -1;
			memcpy(exe, v, (size_t)(p - v));
			exe[p - v] = '\0';
			p++;
		} else if (!strcmp(kbuf, "comm")) {
			if (*p != '"')
				return -1;
			const char *v = ++p;
			size_t ci = 0;

			while (*p && *p != '"') {
				if (ci < 15)
					e->comm[ci++] = *p;
				p++;
			}
			if (*p != '"')
				return -1;
			e->comm[ci] = '\0';
			p++;
		} else if (!strcmp(kbuf, "monoNs")) {
			char *end;

			e->mono_ns = strtoull(p, &end, 10);
			if (end == p)
				return -1;
			p = end;
		} else if (!strcmp(kbuf, "tgid") || !strcmp(kbuf, "ppid") ||
			   !strcmp(kbuf, "uid") || !strcmp(kbuf, "euid")) {
			char *end;
			unsigned long v = strtoul(p, &end, 10);

			if (end == p)
				return -1;
			if (!strcmp(kbuf, "tgid"))
				e->tgid = (uint32_t)v;
			else if (!strcmp(kbuf, "ppid"))
				e->ppid = (uint32_t)v;
			else if (!strcmp(kbuf, "uid"))
				e->uid = (uint32_t)v;
			else
				e->euid = (uint32_t)v;
			p = end;
		} else {
			return -1; /* unknown field: reject, never guess */
		}

		fields++;
		while (*p == ' ' || *p == ',')
			p++;
	}
	/* a valid record must close and carry at least stamp + identity */
	if (*p != '}' || fields < 5)
		return -1;
	snprintf((char *)e->payload, 192, "%s", exe);
	return 0;
}

struct out {
	char idx[128][VIG_INDEX_LINE_MAX];
	size_t n;
};

static void out_fn(void *user, const struct vig_event *e,
		   const struct timespec *wall)
{
	struct out *o = user;

	vig_index_line(e, wall, o->idx[o->n], VIG_INDEX_LINE_MAX);
	o->n++;
}

static long extract_mono(const char *idx_line)
{
	const char *m = strstr(idx_line, "\"monoNs\":");

	if (!m)
		return -1;
	return strtol(m + 9, NULL, 10);
}

static void extract_at(const char *idx_line, char *dst, size_t cap)
{
	const char *m = strstr(idx_line, "\"at\":\"");

	if (!m) {
		dst[0] = '\0';
		return;
	}
	m += 6;
	const char *end = strchr(m, '"');
	size_t len = end ? (size_t)(end - m) : 0;

	if (len >= cap)
		len = cap - 1;
	memcpy(dst, m, len);
	dst[len] = '\0';
}

int main(void)
{
	char path[512];

	snprintf(path, sizeof path, "%s/events.jsonl", FIXTURES_DIR);
	FILE *fp = fopen(path, "r");

	CHECK(fp != NULL);
	if (!fp)
		return 1;

	struct fake_clock fc = { 1000000, { 1700000000, 0 } };
	struct vig_clocks clocks = { fake_mono, fake_wall, &fc };
	struct vig_pipeline *p = vig_pipeline_create(&clocks, 100000000ULL);
	struct out out = { 0 };
	struct vig_syslog *slog = vig_syslog_open(NULL);

	CHECK(p != NULL);
	CHECK(slog != NULL);
	vig_pipeline_set_emit(p, out_fn, &out);

	char line[512];
	int pushed = 0, rejected = 0;

	while (fgets(line, sizeof line, fp)) {
		size_t len = strlen(line);

		if (len && line[len - 1] == '\n')
			line[len - 1] = '\0';
		if (!line[0])
			continue;

		struct vig_event e;
		char exe[192];

		if (parse_fixture_line(line, &e, exe, sizeof exe) != 0) {
			rejected++;
			continue;
		}
		CHECK(vig_pipeline_push(p, &e) == 0);
		pushed++;
	}
	fclose(fp);

	/* the good fixture pushes; nothing is rejected there */
	CHECK(pushed == 6);
	CHECK(rejected == 0);

	/* the malformed fixture: every line is refused, never emitted */
	snprintf(path, sizeof path, "%s/malformed.jsonl", FIXTURES_DIR);
	fp = fopen(path, "r");
	CHECK(fp != NULL);
	if (fp) {
		int malformed_lines = 0, malformed_rejected = 0;

		while (fgets(line, sizeof line, fp)) {
			size_t len = strlen(line);

			if (len && line[len - 1] == '\n')
				line[len - 1] = '\0';
			if (!line[0])
				continue;
			malformed_lines++;
			struct vig_event e;
			char exe[192];

			if (parse_fixture_line(line, &e, exe, sizeof exe) != 0)
				malformed_rejected++;
		}
		fclose(fp);
		CHECK(malformed_lines == 3);
		CHECK(malformed_rejected == malformed_lines);
	}

	/* close the window: newest stamp is fixture-line 1 */
	fc.mono_ns = 99999999999ULL;
	CHECK(vig_pipeline_flush(p) == pushed);

	/* every emitted index line: monotonic monoNs AND non-regressing at */
	long prev_mono = -1;
	char prev_at[64] = "";

	for (size_t i = 0; i < out.n; i++) {
		long mono = extract_mono(out.idx[i]);
		char at[64];

		CHECK(mono >= 0);
		CHECK(mono >= prev_mono); /* monotonic order */
		extract_at(out.idx[i], at, sizeof at);
		CHECK(strlen(at) == 24); /* 2026-10-09T18:04:11.203Z shape */
		CHECK(at[4] == '-' && at[7] == '-' && at[10] == 'T' &&
		      at[13] == ':' && at[16] == ':' && at[19] == '.' &&
		      at[23] == 'Z');
		if (prev_at[0] && strcmp(at, prev_at) == 0)
			CHECK(mono >= prev_mono); /* same-ms ordering holds */
		else if (prev_at[0])
			CHECK(strcmp(at, prev_at) > 0); /* wall never regresses */
		prev_mono = mono;
		strcpy(prev_at, at);
	}
	CHECK(out.n == (size_t)pushed);

	/* syslog grammar over the same records: replay every raw fixture
	 * event through the builder and validate the message shape */
	{
		snprintf(path, sizeof path, "%s/events.jsonl", FIXTURES_DIR);
		FILE *fp2 = fopen(path, "r");

		CHECK(fp2 != NULL);
		while (fgets(line, sizeof line, fp2)) {
			size_t len = strlen(line);

			if (len && line[len - 1] == '\n')
				line[len - 1] = '\0';

			struct vig_event e;
			char exe[192];

			if (parse_fixture_line(line, &e, exe, sizeof exe) != 0)
				continue; /* malformed fixture line */

			struct timespec wall = { 1728482651, 203000000 };
			char sl[2048];

			CHECK(vig_syslog_line(VIG_SYSLOG_PRI_OP,
					      VIG_SYSLOG_MSGID_OP, &e, &wall,
					      "laptop01", 1421, sl,
					      sizeof sl) > 0);
			CHECK(strncmp(sl, "<34>1 ", 6) == 0);
			CHECK(strstr(sl, "vigil-kernel-monitor") != NULL);
			CHECK(strstr(sl, "VIGOP") != NULL);
			CHECK(strstr(sl, "[vigil@vigil ") != NULL);
		}
		fclose(fp2);
	}

	vig_pipeline_destroy(p);
	vig_syslog_close(slog);
	TEST_END();
}
