/* Deterministic rule evaluation over the ordered record stream.
 *
 * Rules are data (JSON files under rules/); the evaluator is fixed. A rule
 * names one
 * record kind and declares matchers; a record matches a rule when every
 * matcher the rule declares holds. Matching reads nothing but the record
 * itself plus two pieces of stream state the evaluator maintains in record
 * order — recent euid→0 transitions (for escalation windows) and the
 * previous monitor.health drop counter. Both come from the records' own
 * monotonic stamps; no wall clock and no environment state ever enters
 * matching, so the same stream always produces the same alerts.
 *
 * Any rule file the loader cannot fully understand — malformed JSON, an
 * unknown kind, an unknown matcher key, a wrong type, a duplicate name —
 * fails the WHOLE load with the offending file named: the daemon refuses to
 * start rather than run a rule set it misunderstood.
 */
#ifndef VIG_RULES_H
#define VIG_RULES_H

#include <stddef.h>
#include <stdint.h>

#include "event.h"

/* Where the daemon looks for rules when --rules-dir is not given. The
 * packaging PR installs the shipped rules there. */
#define VIG_RULES_DIR_DEFAULT "/etc/vigil/kernel-monitor/rules"

struct vig_rules;

/* Load every *.json file in dir, in sorted-filename order (which is also
 * the match order). Returns NULL with a human-readable reason in err on any
 * problem — a missing directory is a problem, not an empty rule set: a
 * monitor with no rules would silently alert on nothing. */
struct vig_rules *vig_rules_load(const char *dir, char *err, size_t err_cap);
void vig_rules_free(struct vig_rules *r);

/* Number of loaded rules; also the match cap that guarantees no match is
 * ever dropped by vig_rules_evaluate (a rule matches a record at most once). */
size_t vig_rules_count(const struct vig_rules *r);

/* One rule match, in rule-load order. */
struct vig_rule_match {
	const char *rule;
	const char *severity; /* "critical" or "warning" */
};

/* Evaluate one record from the ordered stream. Call once per record, in
 * pipeline-release order — stream state (escalation marks, health delta)
 * is only meaningful when records arrive the way the pipeline releases
 * them. Writes at most cap matches; pass vig_rules_count(r) to make
 * truncation impossible. */
size_t vig_rules_evaluate(struct vig_rules *r, const struct vig_event *e,
			  struct vig_rule_match *out, size_t cap);

#endif
