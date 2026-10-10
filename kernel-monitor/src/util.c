#include "util.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>

int vig_json_escape(const char *src, char *dst, size_t cap)
{
	size_t o = 0;

	for (const unsigned char *p = (const unsigned char *)src; *p; p++) {
		char out[8];
		size_t n;

		switch (*p) {
		case '"': n = (size_t)snprintf(out, sizeof out, "\\\""); break;
		case '\\': n = (size_t)snprintf(out, sizeof out, "\\\\"); break;
		case '\b': n = (size_t)snprintf(out, sizeof out, "\\b"); break;
		case '\f': n = (size_t)snprintf(out, sizeof out, "\\f"); break;
		case '\n': n = (size_t)snprintf(out, sizeof out, "\\n"); break;
		case '\r': n = (size_t)snprintf(out, sizeof out, "\\r"); break;
		case '\t': n = (size_t)snprintf(out, sizeof out, "\\t"); break;
		default:
			if (*p < 0x20)
				n = (size_t)snprintf(out, sizeof out, "\\u%04x", *p);
			else
				n = (size_t)snprintf(out, sizeof out, "%c", *p);
			break;
		}
		if (o + n >= cap)
			return -1;
		memcpy(dst + o, out, n);
		o += n;
	}
	dst[o] = '\0';
	return 0;
}

int vig_iso8601_ms(const struct timespec *wall, char *dst, size_t cap)
{
	struct tm tm;
	time_t sec = wall->tv_sec;
	long ms = wall->tv_nsec / 1000000L;

	if (ms < 0)
		ms = 0;
	if (ms > 999)
		ms = 999;
	if (!gmtime_r(&sec, &tm))
		return -1;
	if (strftime(dst, cap, "%Y-%m-%dT%H:%M:%S", &tm) == 0)
		return -1;
	size_t len = strlen(dst);

	if (len + 6 >= cap) /* ".mmmZ" plus NUL */
		return -1;
	snprintf(dst + len, cap - len, ".%03ldZ", ms);
	return 0;
}

int vig_mkdir_p(const char *path, int mode)
{
	char buf[4096];
	size_t len = strlen(path);

	if (len == 0 || len >= sizeof buf) {
		errno = len ? ENAMETOOLONG : EINVAL;
		return -1;
	}
	memcpy(buf, path, len + 1);
	/* strip a trailing slash so the final mkdir targets the dir itself */
	while (len > 1 && buf[len - 1] == '/')
		buf[--len] = '\0';

	for (char *p = buf + 1; *p; p++) {
		if (*p == '/') {
			*p = '\0';
			if (mkdir(buf, mode) != 0 && errno != EEXIST)
				return -1;
			*p = '/';
		}
	}
	if (mkdir(buf, mode) != 0 && errno != EEXIST)
		return -1;
	return 0;
}
