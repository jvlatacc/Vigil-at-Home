/* Daemon-generated monitor.health records: hook matrix, drop counter,
 * degraded flag. The kind-specific fields ride in the record payload as a
 * pre-rendered JSON fragment the index builder splices in verbatim — the
 * closed event schema has no per-field home for them. */
#ifndef VIG_HEALTH_H
#define VIG_HEALTH_H

#include <stdbool.h>
#include <stdint.h>

#include "event.h"

/* hooks entries are attached hook ids plus "feature/<name>=<yes|no>" probes
 * (the health schema is closed, so the feature matrix rides the string list). */
int vig_health_event(struct vig_event *out, uint64_t mono_ns,
		     uint32_t daemon_pid, uint64_t dropped_total,
		     const char *const *hooks, size_t hooks_n, bool degraded);

/* Reader side of the pre-rendered fragment vig_health_event writes: pull
 * the droppedTotal counter out of a health record's payload. Returns 0, or
 * -1 when the payload does not carry the counter (a contract bug — never
 * guessed). Lives here so the fragment format has one owner file. */
int vig_health_dropped_total(const struct vig_event *e, uint64_t *out);

#endif
