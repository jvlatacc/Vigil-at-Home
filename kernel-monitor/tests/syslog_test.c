/* RFC 5424 grammar: every emitted line must parse as
 * <PRI>1 TIMESTAMP HOSTNAME APP-NAME PROCID MSGID SD MSG
 * with a real timestamp and the index JSON as the body. */
#define _GNU_SOURCE /* strptime */
#include "test_harness.h"

#include "../src/index.h"
#include "../src/syslog_emit.h"

#include <string.h>

static struct vig_event mk_exec(void)
{
	struct vig_event e;

	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_EXEC;
	e.mono_ns = 42;
	e.tgid = 20531;
	e.ppid = 20510;
	e.uid = 1000;
	e.euid = 1000;
	strcpy(e.comm, "sh");
	snprintf((char *)e.payload, sizeof(e.payload), "%s", "/tmp/x");
	return e;
}

/* strptime with a fixed format both validates the shape and re-derives the
 * time — a malformed timestamp fails the parse, which fails the build. */
static int timestamp_parses(const char *ts)
{
	struct tm tm;
	const char *rest = strptime(ts, "%Y-%m-%dT%H:%M:%S", &tm);

	if (!rest)
		return 0;
	/* optional .mmm fraction, mandatory Z */
	if (*rest == '.') {
		rest++;
		int digits = 0;

		while (*rest >= '0' && *rest <= '9') {
			rest++;
			digits++;
		}
		if (digits != 3)
			return 0;
	}
	return strcmp(rest, "Z") == 0;
}

int main(void)
{
	struct vig_event e = mk_exec();
	struct timespec wall = { 1728482651, 203000000 }; /* .203Z */
	char line[2048];

	/* 1. full grammar on the pure builder */
	{
		int n = vig_syslog_line(VIG_SYSLOG_PRI_OP, VIG_SYSLOG_MSGID_OP,
					&e, &wall, "laptop01", 1421, line,
					sizeof line);

		CHECK(n > 0);

		int pri = -1, ver = -1, procid = -1;
		char ts[64] = "", host[64] = "", app[64] = "", msgid[16] = "";

		CHECK(sscanf(line, "<%d>%d %63[^ ] %63[^ ] %63[^ ] %d %15[^ ]",
			     &pri, &ver, ts, host, app, &procid, msgid) == 7);
		CHECK(pri == VIG_SYSLOG_PRI_OP);
		CHECK(ver == 1);
		CHECK(timestamp_parses(ts));
		CHECK(strcmp(host, "laptop01") == 0);
		CHECK(strcmp(app, "vigil-kernel-monitor") == 0);
		CHECK(strcmp(msgid, "VIGOP") == 0);

		/* structured data element with named params (SD-ID is a bare
		 * NAME in RFC 5424 — never quoted) */
		const char *sd = strstr(line, "[vigil@vigil kind=\"exec\"");

		CHECK(sd != NULL);
		CHECK(strstr(line, "kind=\"exec\"") != NULL);
		CHECK(strstr(line, "tgid=\"20531\"") != NULL);
		CHECK(strstr(line, "ppid=\"20510\"") != NULL);
		CHECK(strstr(line, "uid=\"1000\"") != NULL);
		/* euid == uid → omitted, matching the spec's sample */

		/* the JSON body mirrors the index line exactly */
		const char *body = strstr(line, "{\"kind\":\"process.exec\"");

		CHECK(body != NULL);
		char idx[VIG_INDEX_LINE_MAX];

		CHECK(vig_index_line(&e, &wall, idx, sizeof idx) > 0);
		CHECK(strcmp(body, idx) == 0);
	}

	/* 2. euid appears when it differs from uid */
	{
		e.euid = 0;
		CHECK(vig_syslog_line(VIG_SYSLOG_PRI_OP, VIG_SYSLOG_MSGID_OP,
				      &e, &wall, "laptop01", 1421, line,
				      sizeof line) > 0);
		CHECK(strstr(line, "euid=\"0\"") != NULL);
		e.euid = 1000;
	}

	/* 3. in-memory sink records emitted lines in order */
	{
		struct vig_syslog *s = vig_syslog_open(NULL);
		size_t n;
		const char *const *rec;

		CHECK(s != NULL);
		CHECK(vig_syslog_emit(s, VIG_SYSLOG_PRI_OP, VIG_SYSLOG_MSGID_OP,
				      &e, &wall, "laptop01") == 0);
		e.tgid = 20532;
		CHECK(vig_syslog_emit(s, VIG_SYSLOG_PRI_OP, VIG_SYSLOG_MSGID_OP,
				      &e, &wall, "laptop01") == 0);
		rec = vig_syslog_recorded(s, &n);
		CHECK(n == 2);
		CHECK(strstr(rec[0], "tgid=\"20531\"") != NULL);
		CHECK(strstr(rec[1], "tgid=\"20532\"") != NULL);
		vig_syslog_close(s);
	}

	/* 4. a truncated line is refused, not emitted malformed */
	{
		char tiny[64];

		CHECK(vig_syslog_line(VIG_SYSLOG_PRI_OP, VIG_SYSLOG_MSGID_OP,
				      &e, &wall, "laptop01", 1421, tiny,
				      sizeof tiny) < 0);
	}

	TEST_END();
}
