/* Small pure helpers shared by the index writer, syslog emitter and daemon. */
#ifndef VIG_UTIL_H
#define VIG_UTIL_H

#include <stddef.h>
#include <time.h>

/* JSON-escape src (no surrounding quotes) into dst. Returns 0, or -1 when
 * dst was too small. Control bytes become \u00XX. */
int vig_json_escape(const char *src, char *dst, size_t cap);

/* Format wall time as RFC 5424 / RFC 3339 UTC with millisecond precision:
 * 2026-10-09T18:04:11.203Z. Returns 0, or -1 when dst was too small. */
int vig_iso8601_ms(const struct timespec *wall, char *dst, size_t cap);

/* mkdir -p: create path (and parents) with the given mode. Returns 0, or
 * -1 with errno set on failure. Existing directories are fine. */
int vig_mkdir_p(const char *path, int mode);

#endif
