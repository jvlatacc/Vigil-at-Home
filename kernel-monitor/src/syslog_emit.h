/* RFC 5424 emitter: one VIGOP message per indexed event, sent to /dev/log
 * (imuxsock — journald strips structured data from this path, so the daemon
 * speaks syslog directly per the decision brief, §5). The JSON message body
 * is the same line the index carries. */
#ifndef VIG_SYSLOG_H
#define VIG_SYSLOG_H

#include <stddef.h>
#include <stdint.h>
#include <time.h>

#include "event.h"

#define VIG_SYSLOG_APP_NAME "vigil-kernel-monitor"
#define VIG_SYSLOG_MSGID_OP "VIGOP"
#define VIG_SYSLOG_SD_ID "vigil@vigil"
/* facility 4 (auth), severity 2 — per the spec's sample message */
#define VIG_SYSLOG_PRI_OP 34

struct vig_syslog;

/* path may be NULL: the sink then records lines in memory (tests). */
struct vig_syslog *vig_syslog_open(const char *path);
void vig_syslog_close(struct vig_syslog *s);

/* Emit one message. Returns 0; drops are counted to stderr, never fatal. */
int vig_syslog_emit(struct vig_syslog *s, int pri, const char *msgid,
		    const struct vig_event *e, const struct timespec *wall,
		    const char *hostname);

/* Pure builder — returns the line length, or -1 when it did not fit. */
int vig_syslog_line(int pri, const char *msgid, const struct vig_event *e,
		    const struct timespec *wall, const char *hostname,
		    int procid, char *buf, size_t cap);

/* In-memory sink access (tests): recorded lines, in emit order. */
const char *const *vig_syslog_recorded(const struct vig_syslog *s, size_t *n);

#endif
