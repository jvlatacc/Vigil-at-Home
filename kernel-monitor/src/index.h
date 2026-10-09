/* JSONL operations index: append one line per event, rotate at a size cap,
 * keep a fixed number of past files. The index is the app's ingestion source
 * (the sensor hub tails it) and the user's own record — the rsyslog file
 * output is a separate copy for admins and collectors, nothing tails both. */
#ifndef VIG_INDEX_H
#define VIG_INDEX_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

#include "event.h"

#define VIG_INDEX_DIR_DEFAULT "/var/lib/vigil/kernel-monitor"
#define VIG_INDEX_BASE_NAME "operations.jsonl"
#define VIG_INDEX_MAX_BYTES_DEFAULT (64ULL << 20) /* rotate at 64 MiB */
#define VIG_INDEX_KEEP_DEFAULT 5
#define VIG_INDEX_LINE_MAX 1024

struct vig_index;

/* Opens (or creates) dir/base. Rotation shifts base.1..base.(keep-1) up one
 * slot and starts a fresh base; nothing older than base.keep survives. */
struct vig_index *vig_index_open(const char *dir, const char *base,
				 uint64_t max_bytes, int keep);
int vig_index_append(struct vig_index *ix, const char *line);
void vig_index_close(struct vig_index *ix);

/* Render one index line for an event at wall time — the exact JSON that both
 * the index and the syslog message body carry (the syslog body mirrors this
 * line byte for byte). Returns the length, or -1 when the line did not fit. */
int vig_index_line(const struct vig_event *e, const struct timespec *wall,
		   char *buf, size_t cap);

#endif
