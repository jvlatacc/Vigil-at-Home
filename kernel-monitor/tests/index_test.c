/* JSONL index: line shape, append, rotation at the size cap, keep-N. */
#include "test_harness.h"

#include "../src/index.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static struct vig_event mk_exec(uint64_t mono_ns, const char *comm)
{
	struct vig_event e;

	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_EXEC;
	e.mono_ns = mono_ns;
	e.tgid = 4242;
	e.ppid = 400;
	e.uid = 1000;
	e.euid = 1000;
	strcpy(e.comm, comm);
	snprintf((char *)e.payload, sizeof(e.payload), "%s", "/tmp/x");
	return e;
}

static int file_lines(const char *path)
{
	FILE *fp = fopen(path, "r");
	int n = 0;
	char buf[4096];

	if (!fp)
		return -1;
	while (fgets(buf, sizeof buf, fp))
		n++;
	fclose(fp);
	return n;
}

int main(void)
{
	struct timespec wall = { 1728482651, 500000000 };
	char line[VIG_INDEX_LINE_MAX];
	char path[512], rot1[512];

	/* 1. the index line is the app's ingestion contract: flat JSON, one
	 * line, known keys — schema the TS parser will consume */
	{
		struct vig_event e = mk_exec(1000, "sh");

		CHECK(vig_index_line(&e, &wall, line, sizeof line) > 0);
		CHECK(strncmp(line, "{\"kind\":\"process.exec\"", 22) == 0);
		CHECK(strstr(line, "\"source\":\"kernel-monitor\"") != NULL);
		CHECK(strstr(line, "\"at\":\"2024-10-09T") != NULL);
		CHECK(strstr(line, "\"monoNs\":1000") != NULL);
		CHECK(strstr(line, "\"tgid\":4242") != NULL);
		CHECK(strstr(line, "\"ppid\":400") != NULL);
		CHECK(strstr(line, "\"uid\":1000") != NULL);
		CHECK(strstr(line, "\"comm\":\"sh\"") != NULL);
		CHECK(strstr(line, "\"exe\":\"/tmp/x\"") != NULL);
		CHECK(strchr(line, '\n') == NULL); /* writer adds the newline */
	}

	/* 2. rotation: base becomes .1, fresh base starts, old .1 drops off
	 * with keep=2 */
	{
		char dir[] = "/tmp/vigil-index-test-XXXXXX";

		CHECK(mkdtemp(dir) != NULL);
		snprintf(path, sizeof path, "%s/operations.jsonl", dir);
		snprintf(rot1, sizeof rot1, "%s.1", path);

		struct vig_index *ix = vig_index_open(dir, "operations.jsonl",
						      100 /* tiny cap */,
						      2);

		CHECK(ix != NULL);

		/* first append always fits (cap check requires size > 0) */
		CHECK(vig_index_append(ix, line) == 0);
		CHECK(access(path, F_OK) == 0);
		/* keep appending until the writer rotates at the 100-byte cap */
		struct vig_event e2 = mk_exec(2, "longer-command-name");

		char line2[VIG_INDEX_LINE_MAX];

		CHECK(vig_index_line(&e2, &wall, line2, sizeof line2) > 0);
		CHECK(vig_index_append(ix, line2) == 0);
		CHECK(vig_index_append(ix, line2) == 0);
		CHECK(vig_index_append(ix, line2) == 0);
		CHECK(vig_index_append(ix, line2) == 0);
		CHECK(vig_index_append(ix, line2) == 0);
		vig_index_close(ix);

		/* the base file exists and rotation left at most one generation */
		CHECK(access(path, F_OK) == 0);
		CHECK(file_lines(path) >= 1);
		CHECK(file_lines(rot1) >= 1);
		/* keep=2: base, .1, .2 — .3 must not exist */
		char rot3[512];

		snprintf(rot3, sizeof rot3, "%s.3", path);
		CHECK(access(rot3, F_OK) != 0);

		/* every rotated line still parses as flat JSON with kind */
		FILE *fp = fopen(rot1, "r");

		CHECK(fp != NULL);
		char buf[512];

		while (fp && fgets(buf, sizeof buf, fp)) {
			CHECK(strstr(buf, "{\"kind\":\"") == buf);
			CHECK(strchr(buf, '\n') != NULL);
		}
		if (fp)
			fclose(fp);

		char del[512];

		snprintf(del, sizeof del, "rm -rf %s", dir);
		CHECK(system(del) == 0);
		(void)errno;
	}

	/* 3. an unknown kind refuses to render — no guessed JSON */
	{
		struct vig_event e = mk_exec(7, "x");

		e.kind = (enum vig_kind)999;
		CHECK(vig_index_line(&e, &wall, line, sizeof line) < 0);
	}

	TEST_END();
}
