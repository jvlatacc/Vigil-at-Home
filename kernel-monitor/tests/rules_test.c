/* The rule evaluator: the six shipped rules fire from positive fixtures and
 * stay silent from negatives; the loader fails loudly on bad rule data; the
 * escalation window, health drop delta, and alert emission all run on the
 * record's own timeline — no wall clock in matching. */
#include "test_harness.h"

#include "../src/event.h"
#include "../src/health.h"
#include "../src/index.h"
#include "../src/payload.h"
#include "../src/rules.h"
#include "../src/syslog_emit.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* the shipped rule data: fixtures -> tests -> kernel-monitor/rules */
#define RULES_DIR FIXTURES_DIR "/../../rules"

#define MS 1000000ULL
#define S  1000000000ULL

static void put_u32le(uint8_t *p, uint32_t v)
{
	p[0] = (uint8_t)(v & 0xff);
	p[1] = (uint8_t)((v >> 8) & 0xff);
	p[2] = (uint8_t)((v >> 16) & 0xff);
	p[3] = (uint8_t)((v >> 24) & 0xff);
}

static void put_u16le(uint8_t *p, uint16_t v)
{
	p[0] = (uint8_t)(v & 0xff);
	p[1] = (uint8_t)((v >> 8) & 0xff);
}

static void put_path(uint8_t *dst, size_t cap, const char *path)
{
	snprintf((char *)dst, cap, "%s", path);
}

static struct vig_event base(uint32_t kind, uint64_t mono_ns)
{
	struct vig_event e;

	memset(&e, 0, sizeof e);
	e.kind = kind;
	e.mono_ns = mono_ns;
	e.tgid = 500;
	e.ppid = 10;
	e.uid = 1000;
	e.euid = 1000;
	strcpy(e.comm, "proc");
	return e;
}

static struct vig_event mk_exec(const char *exe, uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_EXEC, mono_ns);

	put_path(e.payload, VIG_PAYLOAD_MAX, exe);
	return e;
}

static struct vig_event mk_open_w(const char *path, uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_FILE_MUT, mono_ns);

	e.payload[0] = VIG_FILE_OPEN_W;
	put_u32le(&e.payload[1], VIG_O_WRONLY);
	put_path(&e.payload[5], VIG_PAYLOAD_MAX - 5, path);
	return e;
}

static struct vig_event mk_unlink(const char *path, uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_FILE_MUT, mono_ns);

	e.payload[0] = VIG_FILE_UNLINK;
	put_path(&e.payload[1], VIG_PAYLOAD_MAX - 1, path);
	return e;
}

static struct vig_event mk_trunc(const char *path, uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_FILE_MUT, mono_ns);

	e.payload[0] = VIG_FILE_TRUNC;
	put_path(&e.payload[1], VIG_PAYLOAD_MAX - 1, path);
	return e;
}

static struct vig_event mk_rename(const char *from, const char *to,
				  uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_FILE_MUT, mono_ns);

	e.payload[0] = VIG_FILE_RENAME;
	put_path(&e.payload[1], VIG_PATH_CAP, from);
	put_path(&e.payload[VIG_PATH_CAP + 1],
		 VIG_PAYLOAD_MAX - VIG_PATH_CAP - 1, to);
	return e;
}

static struct vig_event mk_listen(uint8_t op, uint16_t family, uint16_t port,
				  const uint8_t *addr, size_t addr_len,
				  uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_NET_LISTEN, mono_ns);

	e.payload[0] = op;
	put_u16le(&e.payload[1], family);
	put_u16le(&e.payload[3], port);
	memcpy(&e.payload[5], addr, addr_len);
	return e;
}

static struct vig_event mk_priv(uint32_t from, uint32_t to, uint8_t src,
				const char *comm, uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_PRIV, mono_ns);

	put_u32le(&e.payload[0], from);
	put_u32le(&e.payload[4], to);
	memset(&e.payload[8], 0, 8); /* empty capability set */
	e.payload[16] = src;
	snprintf(e.comm, sizeof e.comm, "%s", comm);
	return e;
}

static struct vig_event mk_module(uint8_t op, const char *name,
				  uint64_t mono_ns)
{
	struct vig_event e = base(VIG_OP_MODULE, mono_ns);

	e.payload[0] = op;
	put_path(&e.payload[1], VIG_PAYLOAD_MAX - 1, name);
	return e;
}

static struct vig_event mk_health(uint64_t dropped, uint64_t mono_ns)
{
	struct vig_event e;
	const char *hooks[] = { "tracepoint/sched/sched_process_exec" };

	CHECK(vig_health_event(&e, mono_ns, 4242, dropped, hooks, 1,
			       false) == 0);
	return e;
}

static int has(struct vig_rule_match *m, size_t n, const char *name)
{
	for (size_t i = 0; i < n; i++)
		if (strcmp(m[i].rule, name) == 0)
			return 1;
	return 0;
}

static char tdir[256];

static void write_rule(const char *name, const char *content)
{
	char path[512];
	FILE *f;

	snprintf(path, sizeof path, "%s/%s", tdir, name);
	f = fopen(path, "w");
	CHECK(f != NULL);
	if (!f)
		return;
	fputs(content, f);
	fclose(f);
}

int main(void)
{
	struct vig_rule_match m[8];
	size_t n;

	/* 1. the shipped rule set loads and has the six spec names */
	struct vig_rules *rules = vig_rules_load(RULES_DIR, NULL, 0);

	CHECK(rules != NULL);
	if (!rules)
		return 1;
	/* six spec rules plus the monitor-health drop threshold */
	CHECK(vig_rules_count(rules) == 7);

	/* 2. exec-from-writable: positive and negatives */
	struct vig_event e;

	e = mk_exec("/tmp/x", 100 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "exec-from-writable"));
	CHECK(strcmp(m[0].severity, "critical") == 0);

	e = mk_exec("/var/tmp/x", 100 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "exec-from-writable"));

	e = mk_exec("/dev/shm/x", 100 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "exec-from-writable"));

	e = mk_exec("/home/user/bin/ls", 100 * S); /* the acceptance negative */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_exec("/tmpfactory/x", 100 * S); /* segment boundary */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_exec("", 100 * S); /* record with a failed path read */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	/* 3. exec-after-escalation: 5 s window on the record's own clock */
	struct vig_event esc = mk_priv(1000, 0, VIG_PRIV_CAPSET, "curl",
				       10 * S);

	n = vig_rules_evaluate(rules, &esc, m, 8);
	CHECK(n == 1 && has(m, n, "capability-grant"));

	e = mk_exec("/usr/bin/x", 10 * S + 4900 * MS);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "exec-after-escalation"));

	e = mk_exec("/usr/bin/x", 10 * S + 5100 * MS); /* just outside */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_exec("/usr/bin/x", 16 * S); /* the 6 s acceptance negative */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_exec("/usr/bin/x", 10 * S + 100 * MS);
	e.tgid = 999; /* another task entirely */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	/* a creds-source escalation does not alert capability-grant but
	 * still arms the exec-after-escalation window for its task */
	struct vig_event creds = mk_priv(1000, 0, VIG_PRIV_CREDS, "setuid-x",
					 20 * S);

	n = vig_rules_evaluate(rules, &creds, m, 8);
	CHECK(n == 0);
	e = mk_exec("/usr/bin/x", 20 * S + 100 * MS);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "exec-after-escalation"));

	/* 4. capability-grant: allowlist and target checks */
	e = mk_priv(1000, 0, VIG_PRIV_CAPSET, "sudo", 30 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0); /* the acceptance negative: sudo is exempt */

	e = mk_priv(1000, 0, VIG_PRIV_CAPSET, "pkexec", 30 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_priv(1000, 1000, VIG_PRIV_CAPSET, "curl", 30 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0); /* not to euid 0 */

	e = mk_priv(0, 0, VIG_PRIV_CAPSET, "curl", 30 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0); /* from == to: not a transition */

	e = mk_priv(1000, 0, VIG_PRIV_CAPSET, "curl", 30 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "capability-grant")); /* acceptance positive */

	/* 5. protected-path-mutation: prefixes, suffixes, renames */
	e = mk_open_w("/etc/passwd", 40 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "protected-path-mutation"));
	CHECK(strcmp(m[0].severity, "warning") == 0);

	e = mk_open_w("/etc", 40 * S); /* the directory itself is a hit */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_unlink("/boot/vmlinuz", 40 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_trunc("/usr/bin/ls", 40 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_open_w("/home/user/notes.txt", 40 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_open_w("/home/user/evil.service", 40 * S); /* suffix */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_open_w("/home/user/evil.service2", 40 * S); /* not a suffix */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	e = mk_rename("/tmp/a", "/etc/passwd", 40 * S); /* new endpoint */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_rename("/etc/shadow", "/tmp/a", 40 * S); /* old endpoint */
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_rename("/tmp/a", "/home/user/b", 40 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	/* 6. foreign-listen: loopback silent, everything else alerts */
	uint8_t lo4[4] = { 127, 0, 0, 1 };
	uint8_t any4[4] = { 0, 0, 0, 0 };
	uint8_t ext4[4] = { 10, 0, 0, 5 };
	uint8_t lo6[16] = { 0 };
	uint8_t ext6[16] = { 0xfd, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
			     0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 };

	lo6[15] = 1;

	e = mk_listen(VIG_NET_BIND, VIG_AF_INET, 4444, lo4, 4, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0); /* loopback bind stays silent */

	e = mk_listen(VIG_NET_BIND, VIG_AF_INET, 4444, ext4, 4, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "foreign-listen"));

	e = mk_listen(VIG_NET_LISTEN_OP, VIG_AF_INET, 4444, any4, 4, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1); /* 0.0.0.0 listen is foreign */

	e = mk_listen(VIG_NET_LISTEN_OP, VIG_AF_INET, 9090, ext4, 4, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_listen(VIG_NET_BIND, VIG_AF_INET6, 4444, lo6, 16, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0); /* ::1 stays silent */

	e = mk_listen(VIG_NET_BIND, VIG_AF_INET6, 4444, ext6, 16, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1);

	e = mk_listen(VIG_NET_BIND, VIG_AF_UNIX, 0,
		      (const uint8_t *)"/run/x.sock", 12, 50 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0); /* unix sockets never match a network rule */

	/* 7. module-load: load alerts, unload is silent */
	e = mk_module(VIG_MODULE_LOAD, "evil", 60 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 1 && has(m, n, "module-load"));

	e = mk_module(VIG_MODULE_UNLOAD, "evil", 60 * S);
	n = vig_rules_evaluate(rules, &e, m, 8);
	CHECK(n == 0);

	/* 8. monitor.health: the drop threshold fires on the delta */
	struct vig_rules *fresh = vig_rules_load(RULES_DIR, NULL, 0);

	CHECK(fresh != NULL);
	if (fresh) {
		e = mk_health(5000, 70 * S); /* first record: no previous */
		n = vig_rules_evaluate(fresh, &e, m, 8);
		CHECK(n == 0);

		e = mk_health(6000, 70 * S + 1); /* delta 1000: alert */
		n = vig_rules_evaluate(fresh, &e, m, 8);
		CHECK(n == 1 && has(m, n, "monitor-health"));

		e = mk_health(6100, 70 * S + 2); /* delta 100: silent */
		n = vig_rules_evaluate(fresh, &e, m, 8);
		CHECK(n == 0);

		e = mk_health(6200, 70 * S + 3);
		e.payload[0] = 'g'; /* corrupt the fragment: undecodable */
		n = vig_rules_evaluate(fresh, &e, m, 8);
		CHECK(n == 0); /* never guessed */

		e = mk_health(6250, 70 * S + 4); /* delta from last GOOD: 150 */
		n = vig_rules_evaluate(fresh, &e, m, 8);
		CHECK(n == 0);

		e = mk_health(7251, 70 * S + 5); /* delta 1001: alert */
		n = vig_rules_evaluate(fresh, &e, m, 8);
		CHECK(n == 1 && has(m, n, "monitor-health"));
		vig_rules_free(fresh);
	}

	/* 9. alert emission: VIGALERT grammar, rule and severity in the
	 * structured data, index line as the body */
	{
		struct vig_syslog *s = vig_syslog_open(NULL);
		struct timespec wall = { 1728482651, 203000000 };
		char idx[VIG_INDEX_LINE_MAX];

		CHECK(s != NULL);
		e = mk_exec("/tmp/x", 100 * S);
		n = vig_rules_evaluate(rules, &e, m, 8);
		CHECK(n == 1);
		CHECK(vig_syslog_alert_pri("critical") ==
		      VIG_SYSLOG_PRI_ALERT_CRITICAL);
		CHECK(vig_syslog_alert_pri("warning") ==
		      VIG_SYSLOG_PRI_ALERT_WARNING);
		CHECK(vig_syslog_alert_pri("bogus") == -1);
		CHECK(vig_syslog_alert(s, VIG_SYSLOG_PRI_ALERT_CRITICAL,
				       "exec-from-writable", "critical", &e,
				       &wall, "laptop01") == 0);

		size_t ln = 0;
		const char *const *lines = vig_syslog_recorded(s, &ln);

		CHECK(ln == 1);
		CHECK(lines && strstr(lines[0], "VIGALERT") != NULL);
		CHECK(lines &&
		      strstr(lines[0], "rule=\"exec-from-writable\"") != NULL);
		CHECK(lines && strstr(lines[0], "sev=\"critical\"") != NULL);
		CHECK(vig_index_line(&e, &wall, idx, sizeof idx) > 0);
		CHECK(lines && strstr(lines[0], idx) != NULL);
		vig_syslog_close(s);
	}

	/* 10. the loader fails loudly, at load time, with the file named */
	snprintf(tdir, sizeof tdir, "/tmp/vig-rules-XXXXXX");
	CHECK(mkdtemp(tdir) != NULL);
	if (!tdir[0])
		return 1;

	struct vig_rules *bad;
	char err[256];

	/* missing directory */
	bad = vig_rules_load("/nonexistent/rules-dir", err, sizeof err);
	CHECK(bad == NULL);
	CHECK(err[0] != '\0');

	/* malformed JSON */
	write_rule("a.json", "{not json");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);
	CHECK(strstr(err, "a.json") != NULL);

	/* unknown severity */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"kernel.module\","
			     "\"severity\":\"fatal\",\"match\":{\"ops\":[\"load\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);
	CHECK(strstr(err, "a.json") != NULL);

	/* unknown kind (would silently never fire) */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"process.fork\","
			     "\"severity\":\"warning\",\"match\":{\"pathPrefixes\":[\"/x\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* unknown match key */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"kernel.module\","
			     "\"severity\":\"warning\",\"match\":{\"ops\":[\"load\"],\"path\":\"/x\"}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* non-absolute exec prefix */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"process.exec\","
			     "\"severity\":\"critical\",\"match\":{\"pathPrefixes\":[\"tmp\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* empty match */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"kernel.module\","
			     "\"severity\":\"warning\",\"match\":{}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* missing name */
	write_rule("a.json", "{\"kind\":\"kernel.module\","
			     "\"severity\":\"warning\",\"match\":{\"ops\":[\"load\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* duplicate rule names across two files */
	write_rule("a.json", "{\"name\":\"dup\",\"kind\":\"kernel.module\","
			     "\"severity\":\"warning\",\"match\":{\"ops\":[\"load\"]}}");
	write_rule("b.json", "{\"name\":\"dup\",\"kind\":\"kernel.module\","
			     "\"severity\":\"warning\",\"match\":{\"ops\":[\"load\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* CIDR with host bits set */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"network.listen\","
			     "\"severity\":\"warning\",\"match\":{\"allowCidrs\":[\"127.0.0.1/8\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* CIDR prefix length out of range */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"network.listen\","
			     "\"severity\":\"warning\",\"match\":{\"allowCidrs\":[\"10.0.0.0/33\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* module ops with an unknown verb */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"kernel.module\","
			     "\"severity\":\"warning\",\"match\":{\"ops\":[\"load\",\"modprobe\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* file suffix containing a slash can never match a segment */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"file\","
			     "\"severity\":\"warning\",\"match\":{\"pathSuffixes\":[\"foo/bar\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* exemptComm longer than the kernel's 15-char comm cap */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"privilege.change\","
			     "\"severity\":\"critical\",\"match\":{\"toEuid\":0,"
			     "\"exemptComm\":[\"an-absurdly-long-name\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* zero thresholds can never fire */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"monitor.health\","
			     "\"severity\":\"warning\",\"match\":{\"droppedDeltaMin\":0}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"process.exec\","
			     "\"severity\":\"critical\",\"match\":{\"escalationWindowMs\":0}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* privilege source outside the enum */
	write_rule("a.json", "{\"name\":\"r1\",\"kind\":\"privilege.change\","
			     "\"severity\":\"critical\",\"match\":{\"source\":\"bpf\"}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad == NULL);

	/* a valid directory still loads (positive control) */
	{
		char path[512];

		snprintf(path, sizeof path, "%s/b.json", tdir);
		CHECK(unlink(path) == 0); /* left over from the dup test */
	}
	write_rule("a.json", "{\"name\":\"only\",\"kind\":\"process.exec\","
			     "\"severity\":\"critical\",\"match\":{\"pathPrefixes\":[\"/nonexistent\"]}}");
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad != NULL);
	if (bad) {
		CHECK(vig_rules_count(bad) == 1);
		e = mk_exec("/home/user/bin/ls", 80 * S);
		n = vig_rules_evaluate(bad, &e, m, 8);
		CHECK(n == 0); /* fires never, silently */
		vig_rules_free(bad);
	}

	{
		char path[512];

		snprintf(path, sizeof path, "%s/a.json", tdir);
		CHECK(unlink(path) == 0);
	}
	bad = vig_rules_load(tdir, err, sizeof err);
	CHECK(bad != NULL); /* empty directory: zero rules, loads */
	if (bad)
		vig_rules_free(bad);

	vig_rules_free(rules);
	TEST_END();
}
