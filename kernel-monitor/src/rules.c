#include "rules.h"

#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200112L /* inet_pton, fileno */
#endif

#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include "health.h"
#include "json.h"
#include "payload.h"

#define VIG_RULE_NAME_MAX 64
#define VIG_COMM_MAX 15 /* kernel TASK_COMM_LEN 16 incl. NUL */

/* escalation marks: bounded ring; marks are inserted in stream order, so
 * overwrite of the oldest is the only eviction that can happen */
#define VIG_ESC_CAP 1024

enum vig_rule_sev {
	VIG_SEV_CRITICAL = 1,
	VIG_SEV_WARNING,
};

struct v4_cidr {
	uint8_t addr[4];
	uint8_t bits;
};

struct v6_addr {
	uint8_t addr[16];
};

struct vig_rule {
	char *name;
	char *description;
	enum vig_rule_sev sev;
	uint32_t kind;

	/* process.exec — exe path prefixes, and/or an escalation window */
	char **exe_prefixes;
	size_t exe_prefixes_n;
	int has_escalation;
	uint64_t escalation_window_ns;

	/* file — path prefixes and/or final-segment suffixes */
	char **path_prefixes;
	size_t path_prefixes_n;
	char **path_suffixes;
	size_t path_suffixes_n;

	/* network.listen — the addresses that stay silent */
	struct v4_cidr *allow_v4;
	size_t allow_v4_n;
	struct v6_addr *allow_v6;
	size_t allow_v6_n;

	/* privilege.change */
	int has_to_euid;
	uint32_t to_euid;
	int priv_src; /* 0 = any; else enum vig_priv_src */
	char **exempt_comm;
	size_t exempt_comm_n;

	/* kernel.module — bitmask of (1u << op) */
	unsigned module_ops;

	/* monitor.health */
	int has_drop_delta;
	uint64_t drop_delta_min;
};

struct esc_mark {
	uint32_t tgid;
	uint64_t mono_ns;
};

struct vig_rules {
	struct vig_rule *rules;
	size_t n, cap;

	/* stream state, maintained in record order */
	struct esc_mark esc[VIG_ESC_CAP];
	size_t esc_n, esc_next;
	uint64_t last_dropped;
	int have_dropped;
};

static void free_strings(char **v, size_t n)
{
	for (size_t i = 0; i < n; i++)
		free(v[i]);
	free(v);
}

static void free_rule(struct vig_rule *r)
{
	free(r->name);
	free(r->description);
	free_strings(r->exe_prefixes, r->exe_prefixes_n);
	free_strings(r->path_prefixes, r->path_prefixes_n);
	free_strings(r->path_suffixes, r->path_suffixes_n);
	free(r->allow_v4);
	free(r->allow_v6);
	free_strings(r->exempt_comm, r->exempt_comm_n);
}

void vig_rules_free(struct vig_rules *r)
{
	if (!r)
		return;
	for (size_t i = 0; i < r->n; i++)
		free_rule(&r->rules[i]);
	free(r->rules);
	free(r);
}

size_t vig_rules_count(const struct vig_rules *r)
{
	return r ? r->n : 0;
}

/* ---------------------------------------------------------------- loader */

static int name_is_safe(const char *s)
{
	size_t n = strlen(s);

	if (n == 0 || n >= VIG_RULE_NAME_MAX)
		return 0;
	/* SD-param safe identifiers: no quoting or bracket surprises */
	if (!((s[0] >= 'a' && s[0] <= 'z') ||
	      (s[0] >= 'A' && s[0] <= 'Z') || s[0] == '_'))
		return 0;
	for (size_t i = 1; i < n; i++) {
		char c = s[i];

		if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
		      (c >= '0' && c <= '9') || c == '.' || c == '_' ||
		      c == '-'))
			return 0;
	}
	return 1;
}

static char *read_file(const char *path, char *err, size_t err_cap)
{
	FILE *f = fopen(path, "rb");

	if (!f) {
		snprintf(err, err_cap, "%s: cannot read: %s", path,
			 strerror(errno));
		return NULL;
	}
	struct stat st;

	if (fstat(fileno(f), &st) != 0 || st.st_size < 0) {
		fclose(f);
		snprintf(err, err_cap, "%s: cannot size: %s", path,
			 strerror(errno));
		return NULL;
	}
	size_t len = (size_t)st.st_size;
	char *buf = malloc(len + 1);

	if (!buf) {
		fclose(f);
		snprintf(err, err_cap, "%s: out of memory", path);
		return NULL;
	}
	if (fread(buf, 1, len, f) != len) {
		fclose(f);
		free(buf);
		snprintf(err, err_cap, "%s: short read", path);
		return NULL;
	}
	fclose(f);
	buf[len] = '\0';
	return buf;
}

static int json_string_array(const vig_json *match, const char *key,
			     char ***out, size_t *out_n, const char *path,
			     char *err, size_t err_cap)
{
	const vig_json *a = vig_json_get(match, key);

	*out = NULL;
	*out_n = 0;
	if (!a)
		return 0; /* absent — no constraint from this matcher */
	if (vig_json_type_of(a) != VIG_JSON_ARRAY) {
		snprintf(err, err_cap, "%s: \"%s\" must be an array", path,
			 key);
		return -1;
	}
	size_t n = vig_json_items(a);
	char **v = NULL;

	if (n) {
		v = calloc(n, sizeof *v);
		if (!v) {
			snprintf(err, err_cap, "%s: out of memory", path);
			return -1;
		}
	}
	for (size_t i = 0; i < n; i++) {
		const char *s = vig_json_string(vig_json_item(a, i));

		if (!s || !*s) {
			snprintf(err, err_cap,
				 "%s: \"%s\"[%zu] must be a non-empty string",
				 path, key, i);
			free_strings(v, i);
			return -1;
		}
		v[i] = strdup(s);
		if (!v[i]) {
			free_strings(v, i);
			snprintf(err, err_cap, "%s: out of memory", path);
			return -1;
		}
	}
	*out = v;
	*out_n = n;
	return 0;
}

static int json_uint(const vig_json *match, const char *key, uint64_t max,
		     uint64_t *out, int *present, const char *path, char *err,
		     size_t err_cap)
{
	const vig_json *v = vig_json_get(match, key);

	*present = 0;
	if (!v)
		return 0;
	*present = 1;
	if (vig_json_type_of(v) != VIG_JSON_NUMBER) {
		snprintf(err, err_cap, "%s: \"%s\" must be a number", path,
			 key);
		return -1;
	}
	double d = vig_json_number(v);

	if (d < 0 || d > (double)max || d != (double)(uint64_t)d) {
		snprintf(err, err_cap,
			 "%s: \"%s\" must be an integer between 0 and %llu",
			 path, key, (unsigned long long)max);
		return -1;
	}
	*out = (uint64_t)d;
	return 0;
}

static int parse_cidr(const char *s, struct v4_cidr *out, const char *path,
		      char *err, size_t err_cap)
{
	char buf[16]; /* "255.255.255.255" + NUL */
	const char *slash = strchr(s, '/');
	size_t alen = slash ? (size_t)(slash - s) : strlen(s);
	unsigned bits = 32;

	if (alen == 0 || alen >= sizeof buf) {
		snprintf(err, err_cap,
			 "%s: \"%s\" is not a dotted-quad CIDR like 127.0.0.0/8",
			 path, s);
		return -1;
	}
	memcpy(buf, s, alen);
	buf[alen] = '\0';

	struct in_addr a;

	if (inet_pton(AF_INET, buf, &a) != 1) {
		snprintf(err, err_cap,
			 "%s: \"%s\" is not a valid IPv4 address", path, buf);
		return -1;
	}
	if (slash) {
		char *end;
		unsigned long b = strtoul(slash + 1, &end, 10);

		if (*end != '\0' || end == slash + 1 || b > 32) {
			snprintf(err, err_cap,
				 "%s: \"%s\" is not a prefix length 0..32",
				 path, slash + 1);
			return -1;
		}
		bits = (unsigned)b;
	}
	/* host bits set is ambiguous — write the masked network address */
	uint32_t mask = bits == 0 ?
				0 :
				bits == 32 ?
				0xFFFFFFFFu :
				~((1u << (32 - bits)) - 1u);
	uint32_t av = ntohl(a.s_addr);

	if (av & ~mask) {
		snprintf(err, err_cap,
			 "%s: \"%s\" has host bits set — write the masked network address",
			 path, s);
		return -1;
	}
	out->addr[0] = (uint8_t)(av >> 24);
	out->addr[1] = (uint8_t)(av >> 16);
	out->addr[2] = (uint8_t)(av >> 8);
	out->addr[3] = (uint8_t)av;
	out->bits = (uint8_t)bits;
	return 0;
}

static const struct {
	const char *name;
	uint32_t kind;
} kind_map[] = {
	{ "process.exec", VIG_OP_EXEC },
	{ "file", VIG_OP_FILE_MUT },
	{ "network.listen", VIG_OP_NET_LISTEN },
	{ "privilege.change", VIG_OP_PRIV },
	{ "kernel.module", VIG_OP_MODULE },
	{ "monitor.health", VIG_OP_HEALTH },
};

static int kind_from_string(const char *s, uint32_t *out, const char *path,
			    char *err, size_t err_cap)
{
	for (size_t i = 0; i < sizeof kind_map / sizeof kind_map[0]; i++) {
		if (strcmp(s, kind_map[i].name) == 0) {
			*out = kind_map[i].kind;
			return 0;
		}
	}
	/* process.fork is a reserved kind this daemon never emits; anything
	 * else unknown would silently never fire — both fail the load */
	snprintf(err, err_cap, "%s: unknown or unsupported rule kind \"%s\"",
		 path, s);
	return -1;
}

/* the exact matcher vocabulary per kind — anything else fails the load */
static const char *const exec_match_keys[] = { "pathPrefixes",
					       "escalationWindowMs", NULL };
static const char *const file_match_keys[] = { "pathPrefixes",
					       "pathSuffixes", NULL };
static const char *const listen_match_keys[] = { "allowCidrs",
						 "allowAddresses", NULL };
static const char *const priv_match_keys[] = { "toEuid", "source",
					       "exemptComm", NULL };
static const char *const module_match_keys[] = { "ops", NULL };
static const char *const health_match_keys[] = { "droppedDeltaMin", NULL };

static int check_match_keys(const vig_json *match, const char *const *keys,
			    const char *path, char *err, size_t err_cap)
{
	size_t n = vig_json_members(match);

	for (size_t i = 0; i < n; i++) {
		const char *key = vig_json_key(match, i);
		int known = 0;

		for (size_t k = 0; keys[k]; k++)
			if (strcmp(key, keys[k]) == 0)
				known = 1;
		if (!known) {
			snprintf(err, err_cap, "%s: unknown match key \"%s\"",
				 path, key);
			return -1;
		}
	}
	return 0;
}

static int load_matchers(struct vig_rule *rule, const vig_json *match,
			 const char *path, char *err, size_t err_cap)
{
	int any = 0;

	switch (rule->kind) {
	case VIG_OP_EXEC: {
		if (json_string_array(match, "pathPrefixes",
				      &rule->exe_prefixes,
				      &rule->exe_prefixes_n, path, err,
				      err_cap) != 0)
			return -1;
		any |= rule->exe_prefixes_n > 0;
		for (size_t i = 0; i < rule->exe_prefixes_n; i++) {
			if (rule->exe_prefixes[i][0] != '/') {
				snprintf(err, err_cap,
					 "%s: pathPrefixes[%zu] must be an absolute path",
					 path, i);
				return -1;
			}
		}
		uint64_t ms;
		int present;

		if (json_uint(match, "escalationWindowMs", 1000000000ULL, &ms,
			      &present, path, err, err_cap) != 0)
			return -1;
		if (present) {
			if (ms < 1) {
				snprintf(err, err_cap,
					 "%s: escalationWindowMs must be at least 1",
					 path);
				return -1;
			}
			rule->has_escalation = 1;
			rule->escalation_window_ns = ms * 1000000ULL;
			any = 1;
		}
		break;
	}
	case VIG_OP_FILE_MUT: {
		if (json_string_array(match, "pathPrefixes",
				      &rule->path_prefixes,
				      &rule->path_prefixes_n, path, err,
				      err_cap) != 0)
			return -1;
		any |= rule->path_prefixes_n > 0;
		for (size_t i = 0; i < rule->path_prefixes_n; i++) {
			if (rule->path_prefixes[i][0] != '/') {
				snprintf(err, err_cap,
					 "%s: pathPrefixes[%zu] must be an absolute path",
					 path, i);
				return -1;
			}
		}
		if (json_string_array(match, "pathSuffixes",
				      &rule->path_suffixes,
				      &rule->path_suffixes_n, path, err,
				      err_cap) != 0)
			return -1;
		any |= rule->path_suffixes_n > 0;
		for (size_t i = 0; i < rule->path_suffixes_n; i++) {
			/* suffixes match the final path segment */
			if (strchr(rule->path_suffixes[i], '/')) {
				snprintf(err, err_cap,
					 "%s: pathSuffixes[%zu] must be a single path segment without '/'",
					 path, i);
				return -1;
			}
		}
		break;
	}
	case VIG_OP_NET_LISTEN: {
		const vig_json *a = vig_json_get(match, "allowCidrs");

		if (a) {
			if (vig_json_type_of(a) != VIG_JSON_ARRAY) {
				snprintf(err, err_cap,
					 "%s: \"allowCidrs\" must be an array",
					 path);
				return -1;
			}
			size_t n = vig_json_items(a);

			rule->allow_v4 = calloc(n ? n : 1,
						sizeof *rule->allow_v4);
			if (!rule->allow_v4) {
				snprintf(err, err_cap, "%s: out of memory",
					 path);
				return -1;
			}
			for (size_t i = 0; i < n; i++) {
				const char *s =
					vig_json_string(vig_json_item(a, i));

				if (!s) {
					snprintf(err, err_cap,
						 "%s: allowCidrs[%zu] must be a string",
						 path, i);
					return -1;
				}
				if (parse_cidr(s, &rule->allow_v4[i], path,
					       err, err_cap) != 0)
					return -1;
				rule->allow_v4_n = i + 1;
			}
			any |= rule->allow_v4_n > 0;
		}
		a = vig_json_get(match, "allowAddresses");
		if (a) {
			if (vig_json_type_of(a) != VIG_JSON_ARRAY) {
				snprintf(err, err_cap,
					 "%s: \"allowAddresses\" must be an array",
					 path);
				return -1;
			}
			size_t n = vig_json_items(a);

			rule->allow_v6 = calloc(n ? n : 1,
						sizeof *rule->allow_v6);
			if (!rule->allow_v6) {
				snprintf(err, err_cap, "%s: out of memory",
					 path);
				return -1;
			}
			for (size_t i = 0; i < n; i++) {
				const char *s =
					vig_json_string(vig_json_item(a, i));

				/* v6 exact addresses; v4 belongs in
				 * allowCidrs, unix listeners never match */
				if (!s ||
				    inet_pton(AF_INET6, s,
					      rule->allow_v6[i].addr) != 1) {
					snprintf(err, err_cap,
						 "%s: allowAddresses[%zu] must be an IPv6 literal (IPv4 uses allowCidrs)",
						 path, i);
					return -1;
				}
				rule->allow_v6_n = i + 1;
			}
			any |= rule->allow_v6_n > 0;
		}
		break;
	}
	case VIG_OP_PRIV: {
		uint64_t v;
		int present;

		if (json_uint(match, "toEuid", 0xFFFFFFFFULL, &v, &present,
			      path, err, err_cap) != 0)
			return -1;
		if (present) {
			rule->has_to_euid = 1;
			rule->to_euid = (uint32_t)v;
			any = 1;
		}
		const char *src = vig_json_string(vig_json_get(match,
							       "source"));

		if (vig_json_get(match, "source")) {
			if (!src) {
				snprintf(err, err_cap,
					 "%s: \"source\" must be a string",
					 path);
				return -1;
			}
			if (strcmp(src, "capset") == 0) {
				rule->priv_src = VIG_PRIV_CAPSET;
			} else if (strcmp(src, "creds") == 0) {
				rule->priv_src = VIG_PRIV_CREDS;
			} else {
				snprintf(err, err_cap,
					 "%s: \"source\" must be \"capset\" or \"creds\"",
					 path);
				return -1;
			}
			any = 1;
		}
		if (json_string_array(match, "exemptComm", &rule->exempt_comm,
				      &rule->exempt_comm_n, path, err,
				      err_cap) != 0)
			return -1;
		any |= rule->exempt_comm_n > 0;
		for (size_t i = 0; i < rule->exempt_comm_n; i++) {
			if (strlen(rule->exempt_comm[i]) > VIG_COMM_MAX) {
				snprintf(err, err_cap,
					 "%s: exemptComm[%zu] is longer than the kernel's 15-character comm cap and could never match",
					 path, i);
				return -1;
			}
		}
		break;
	}
	case VIG_OP_MODULE: {
		const vig_json *a = vig_json_get(match, "ops");

		if (!a || vig_json_type_of(a) != VIG_JSON_ARRAY) {
			snprintf(err, err_cap,
				 "%s: \"ops\" must be an array of \"load\"/\"unload\"",
				 path);
			return -1;
		}
		size_t n = vig_json_items(a);

		for (size_t i = 0; i < n; i++) {
			const char *s = vig_json_string(vig_json_item(a, i));

			if (!s || (strcmp(s, "load") != 0 &&
				   strcmp(s, "unload") != 0)) {
				snprintf(err, err_cap,
					 "%s: ops[%zu] must be \"load\" or \"unload\"",
					 path, i);
				return -1;
			}
			rule->module_ops |= 1u << (strcmp(s, "load") == 0 ?
							  VIG_MODULE_LOAD :
							  VIG_MODULE_UNLOAD);
		}
		any |= rule->module_ops != 0;
		break;
	}
	case VIG_OP_HEALTH: {
		uint64_t v;
		int present;

		if (json_uint(match, "droppedDeltaMin", 1000000000000000ULL,
			      &v, &present, path, err, err_cap) != 0)
			return -1;
		if (present) {
			if (v < 1) {
				snprintf(err, err_cap,
					 "%s: droppedDeltaMin must be at least 1",
					 path);
				return -1;
			}
			rule->has_drop_delta = 1;
			rule->drop_delta_min = v;
			any = 1;
		}
		break;
	}
	default:
		snprintf(err, err_cap, "%s: unsupported kind", path);
		return -1;
	}

	if (!any) {
		snprintf(err, err_cap,
			 "%s: match must declare at least one matcher", path);
		return -1;
	}
	return 0;
}

static int load_rule(struct vig_rules *r, const char *path, const char *text,
		     char *err, size_t err_cap)
{
	char jerr[128];
	vig_json *doc = vig_json_parse(text, jerr, sizeof jerr);

	if (!doc) {
		snprintf(err, err_cap, "%s: %s", path, jerr);
		return -1;
	}

	int rc = -1;
	struct vig_rule rule;

	memset(&rule, 0, sizeof rule);

	if (vig_json_type_of(doc) != VIG_JSON_OBJECT) {
		snprintf(err, err_cap, "%s: the document must be a JSON object",
			 path);
		goto out;
	}

	const char *name = vig_json_string(vig_json_get(doc, "name"));

	if (!name || !name_is_safe(name)) {
		snprintf(err, err_cap,
			 "%s: \"name\" must be a syslog-safe identifier (1..%d characters of [A-Za-z0-9._-], starting with a letter)",
			 path, VIG_RULE_NAME_MAX - 1);
		goto out;
	}
	for (size_t i = 0; i < r->n; i++) {
		if (strcmp(r->rules[i].name, name) == 0) {
			snprintf(err, err_cap, "%s: duplicate rule name \"%s\"",
				 path, name);
			goto out;
		}
	}

	const char *sev = vig_json_string(vig_json_get(doc, "severity"));

	if (!sev) {
		snprintf(err, err_cap, "%s: \"severity\" must be a string",
			 path);
		goto out;
	}
	if (strcmp(sev, "critical") == 0) {
		rule.sev = VIG_SEV_CRITICAL;
	} else if (strcmp(sev, "warning") == 0) {
		rule.sev = VIG_SEV_WARNING;
	} else {
		snprintf(err, err_cap,
			 "%s: \"severity\" must be \"critical\" or \"warning\"",
			 path);
		goto out;
	}

	const char *kind = vig_json_string(vig_json_get(doc, "kind"));

	if (!kind) {
		snprintf(err, err_cap, "%s: \"kind\" must be a string", path);
		goto out;
	}
	if (kind_from_string(kind, &rule.kind, path, err, err_cap) != 0)
		goto out;

	const vig_json *desc = vig_json_get(doc, "description");

	if (desc) {
		const char *d = vig_json_string(desc);

		if (!d) {
			snprintf(err, err_cap,
				 "%s: \"description\" must be a string", path);
			goto out;
		}
		rule.description = strdup(d);
		if (!rule.description) {
			snprintf(err, err_cap, "%s: out of memory", path);
			goto out;
		}
	}

	const vig_json *match = vig_json_get(doc, "match");

	if (!match || vig_json_type_of(match) != VIG_JSON_OBJECT) {
		snprintf(err, err_cap,
			 "%s: \"match\" is required and must be an object",
			 path);
		goto out;
	}

	switch (rule.kind) {
	case VIG_OP_EXEC:
		rc = check_match_keys(match, exec_match_keys, path, err,
				      err_cap);
		break;
	case VIG_OP_FILE_MUT:
		rc = check_match_keys(match, file_match_keys, path, err,
				      err_cap);
		break;
	case VIG_OP_NET_LISTEN:
		rc = check_match_keys(match, listen_match_keys, path, err,
				      err_cap);
		break;
	case VIG_OP_PRIV:
		rc = check_match_keys(match, priv_match_keys, path, err,
				      err_cap);
		break;
	case VIG_OP_MODULE:
		rc = check_match_keys(match, module_match_keys, path, err,
				      err_cap);
		break;
	case VIG_OP_HEALTH:
		rc = check_match_keys(match, health_match_keys, path, err,
				      err_cap);
		break;
	default:
		rc = -1;
		break;
	}
	if (rc != 0)
		goto out;
	if (load_matchers(&rule, match, path, err, err_cap) != 0) {
		rc = -1;
		goto out;
	}

	rule.name = strdup(name);
	if (!rule.name) {
		snprintf(err, err_cap, "%s: out of memory", path);
		rc = -1;
		goto out;
	}

	if (r->n == r->cap) {
		size_t cap = r->cap ? r->cap * 2 : 8;
		struct vig_rule *rules =
			realloc(r->rules, cap * sizeof *rules);

		if (!rules) {
			snprintf(err, err_cap, "%s: out of memory", path);
			rc = -1;
			goto out;
		}
		r->rules = rules;
		r->cap = cap;
	}
	r->rules[r->n++] = rule;
	rc = 0;
out:
	vig_json_free(doc);
	if (rc != 0)
		free_rule(&rule);
	return rc;
}

static int cmp_names(const void *a, const void *b)
{
	return strcmp(*(char *const *)a, *(char *const *)b);
}

struct vig_rules *vig_rules_load(const char *dir, char *err, size_t err_cap)
{
	if (err && err_cap)
		err[0] = '\0';

	struct vig_rules *r = calloc(1, sizeof *r);

	if (!r) {
		snprintf(err, err_cap, "out of memory");
		return NULL;
	}

	DIR *d = opendir(dir);

	if (!d) {
		/* a missing rules directory is a deployment bug: a monitor
		 * with no rules would silently alert on nothing */
		snprintf(err, err_cap, "cannot open rules directory %s: %s",
			 dir, strerror(errno));
		free(r);
		return NULL;
	}

	char **names = NULL;
	size_t n = 0, cap = 0;
	struct dirent *de;
	int failed = 0;

	while (!failed && (de = readdir(d)) != NULL) {
		const char *nm = de->d_name;
		size_t len = strlen(nm);

		if (len < 6 || strcmp(nm + len - 5, ".json") != 0)
			continue;
		if (n == cap) {
			size_t nc = cap ? cap * 2 : 8;
			char **nn = realloc(names, nc * sizeof *nn);

			if (!nn) {
				snprintf(err, err_cap, "out of memory");
				failed = 1;
				break;
			}
			names = nn;
			cap = nc;
		}
		names[n] = strdup(nm);
		if (!names[n]) {
			snprintf(err, err_cap, "out of memory");
			failed = 1;
			break;
		}
		n++;
	}
	closedir(d);

	if (!failed) {
		qsort(names, n, sizeof *names, cmp_names);
		for (size_t i = 0; i < n && !failed; i++) {
			char path[4096];
			int np = snprintf(path, sizeof path, "%s/%s", dir,
					  names[i]);

			if (np < 0 || (size_t)np >= sizeof path) {
				snprintf(err, err_cap, "%s: path too long",
					 dir);
				failed = 1;
				break;
			}
			char *text = read_file(path, err, err_cap);

			if (!text) {
				failed = 1;
				break;
			}
			if (load_rule(r, path, text, err, err_cap) != 0)
				failed = 1;
			free(text);
		}
	}
	for (size_t i = 0; i < n; i++)
		free(names[i]);
	free(names);
	if (failed) {
		/* the load is atomic: one bad file yields no rules at all */
		vig_rules_free(r);
		return NULL;
	}
	return r;
}

/* -------------------------------------------------------------- matching */

static int starts_segment(const char *path, const char *prefix)
{
	size_t len = strlen(prefix);

	if (strncmp(path, prefix, len) != 0)
		return 0;
	return path[len] == '\0' || path[len] == '/';
}

/* suffixes match the final path segment: the segment ends with the
 * configured name (".service" hits "evil.service") */
static int ends_segment(const char *path, const char *name)
{
	const char *slash = strrchr(path, '/');
	const char *seg = slash ? slash + 1 : path;
	size_t sl = strlen(seg), nl = strlen(name);

	return sl >= nl && strcmp(seg + sl - nl, name) == 0;
}

static int str_in(char *const *v, size_t n, const char *s)
{
	for (size_t i = 0; i < n; i++)
		if (strcmp(v[i], s) == 0)
			return 1;
	return 0;
}

static int v4_in(const uint8_t a[4], const struct v4_cidr *c)
{
	if (c->bits == 0)
		return 1;
	uint8_t full = (uint8_t)(c->bits / 8), rem = (uint8_t)(c->bits % 8);

	for (size_t i = 0; i < full; i++)
		if (a[i] != c->addr[i])
			return 0;
	if (rem) {
		uint8_t mask = (uint8_t)(0xFF << (8 - rem));

		if ((a[full] & mask) != (c->addr[full] & mask))
			return 0;
	}
	return 1;
}

static int path_hits(const struct vig_rule *rule, const char *p)
{
	for (size_t i = 0; i < rule->path_prefixes_n; i++)
		if (starts_segment(p, rule->path_prefixes[i]))
			return 1;
	for (size_t i = 0; i < rule->path_suffixes_n; i++)
		if (ends_segment(p, rule->path_suffixes[i]))
			return 1;
	return 0;
}

static int rule_matches(const struct vig_rule *rule, const struct vig_event *e,
			const struct vig_rules *st, uint64_t prev_dropped,
			int had_prev, int have_now)
{
	switch (rule->kind) {
	case VIG_OP_EXEC: {
		char exe[193];

		memcpy(exe, e->payload, 192);
		exe[192] = '\0';
		/* prefixes are any-of: the exe matches when one hits */
		int hit = rule->exe_prefixes_n == 0;

		for (size_t i = 0; i < rule->exe_prefixes_n && !hit; i++)
			if (starts_segment(exe, rule->exe_prefixes[i]))
				hit = 1;
		if (!hit)
			return 0;
		if (rule->has_escalation) {
			int found = 0;

			for (size_t i = 0; i < st->esc_n; i++) {
				const struct esc_mark *m = &st->esc[i];

				if (m->tgid != e->tgid)
					continue;
				/* stamps come from one clock: subtract on
				 * the record's own monotonic timeline */
				if (e->mono_ns >= m->mono_ns &&
				    e->mono_ns - m->mono_ns <=
					    rule->escalation_window_ns) {
					found = 1;
					break;
				}
			}
			if (!found)
				return 0;
		}
		return 1;
	}
	case VIG_OP_FILE_MUT: {
		/* payload per src/payload.h — the same layout index.c reads */
		char path[192], new_path[95];

		switch (e->payload[0]) {
		case VIG_FILE_OPEN_W:
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
			break;
		default:
			return 0; /* unknown action: never guess */
		}
		if (path_hits(rule, path))
			return 1;
		return e->payload[0] == VIG_FILE_RENAME &&
		       path_hits(rule, new_path);
	}
	case VIG_OP_NET_LISTEN: {
		/* [0] op, [1..2] family, [3..4] port, [5..] address — binds
		 * and listens both hold the port open, so both match */
		uint16_t fam;

		memcpy(&fam, &e->payload[1], sizeof fam);
		const uint8_t *ab = &e->payload[5];

		if (fam == VIG_AF_INET) {
			for (size_t i = 0; i < rule->allow_v4_n; i++)
				if (v4_in(ab, &rule->allow_v4[i]))
					return 0;
			return 1;
		}
		if (fam == VIG_AF_INET6) {
			for (size_t i = 0; i < rule->allow_v6_n; i++)
				if (memcmp(ab, rule->allow_v6[i].addr, 16) ==
				    0)
					return 0;
			return 1;
		}
		/* unix sockets are local IPC, not network exposure; unknown
		 * families never guess */
		return 0;
	}
	case VIG_OP_PRIV: {
		uint32_t from, to;

		memcpy(&from, &e->payload[0], sizeof from);
		memcpy(&to, &e->payload[4], sizeof to);
		if (rule->has_to_euid && to != rule->to_euid)
			return 0;
		/* a privilege change is a transition: re-asserting the
		 * same euid (root -> root) is not one */
		if (rule->has_to_euid && from == to)
			return 0;
		if (rule->priv_src && e->payload[16] != rule->priv_src)
			return 0;
		if (rule->exempt_comm_n &&
		    str_in(rule->exempt_comm, rule->exempt_comm_n, e->comm))
			return 0;
		return 1;
	}
	case VIG_OP_MODULE: {
		uint8_t op = e->payload[0];

		if (op != VIG_MODULE_LOAD && op != VIG_MODULE_UNLOAD)
			return 0;
		return (rule->module_ops & (1u << op)) != 0;
	}
	case VIG_OP_HEALTH:
		/* the delta between consecutive health records is the
		 * daemon's own "since last report" — state was updated
		 * before this loop, compared from the previous record */
		return had_prev && have_now &&
		       st->last_dropped >= prev_dropped &&
		       st->last_dropped - prev_dropped >=
			       rule->drop_delta_min;
	default:
		return 0;
	}
}

size_t vig_rules_evaluate(struct vig_rules *r, const struct vig_event *e,
			  struct vig_rule_match *out, size_t cap)
{
	if (!r)
		return 0;

	/* stream state first: this record updates what later records see */
	if (e->kind == VIG_OP_PRIV) {
		uint32_t from, to;

		memcpy(&from, &e->payload[0], sizeof from);
		memcpy(&to, &e->payload[4], sizeof to);
		if (to == 0 && from != 0) {
			/* an escalation: euid became 0 from nonzero */
			struct esc_mark *m = &r->esc[r->esc_next];

			m->tgid = e->tgid;
			m->mono_ns = e->mono_ns;
			r->esc_next = (r->esc_next + 1) % VIG_ESC_CAP;
			if (r->esc_n < VIG_ESC_CAP)
				r->esc_n++;
		}
	}

	uint64_t prev_dropped = r->last_dropped;
	int had_prev = r->have_dropped;
	int have_now = 0;

	if (e->kind == VIG_OP_HEALTH) {
		uint64_t d;

		/* an undecodable health record leaves the delta state
		 * untouched, so no threshold can be lost to it */
		if (vig_health_dropped_total(e, &d) == 0) {
			r->last_dropped = d;
			r->have_dropped = 1;
			have_now = 1;
		}
	}

	size_t n = 0;

	for (size_t i = 0; i < r->n; i++) {
		struct vig_rule *rule = &r->rules[i];

		if (rule->kind != e->kind)
			continue;
		if (!rule_matches(rule, e, r, prev_dropped, had_prev,
				  have_now))
			continue;
		if (n < cap) {
			out[n].rule = rule->name;
			out[n].severity = rule->sev == VIG_SEV_CRITICAL ?
						  "critical" :
						  "warning";
		}
		n++;
	}
	return n;
}
