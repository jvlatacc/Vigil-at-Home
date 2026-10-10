/* Minimal JSON parser for rule files (the RFC 8259 subset the rule files
 * under rules/ need: objects, arrays, strings with escapes, numbers,
 * booleans, null).
 *
 * Hand-rolled like every other parser in this daemon: no third-party
 * dependency, bounded recursion, and every malformation is a loud error
 * naming the 1-based line — a rule file the daemon cannot fully understand
 * must never load. UTF-8 bytes pass through unvalidated; \u escapes (with
 * surrogate pairs) decode to UTF-8.
 */
#ifndef VIG_JSON_H
#define VIG_JSON_H

#include <stddef.h>

typedef struct vig_json vig_json;

typedef enum {
	VIG_JSON_NULL = 1,
	VIG_JSON_BOOL,
	VIG_JSON_NUMBER,
	VIG_JSON_STRING,
	VIG_JSON_ARRAY,
	VIG_JSON_OBJECT,
} vig_json_type;

/* Parse one complete JSON document. Returns NULL and writes a human-readable
 * reason (with the 1-based line) into err on any error — including trailing
 * content after the document. */
vig_json *vig_json_parse(const char *text, char *err, size_t err_cap);

void vig_json_free(vig_json *v);

vig_json_type vig_json_type_of(const vig_json *v);

/* Object member lookup, or NULL when absent or v is not an object. */
const vig_json *vig_json_get(const vig_json *v, const char *key);

/* Object members in document order; 0/NULL when v is not an object. */
size_t vig_json_members(const vig_json *v);
const char *vig_json_key(const vig_json *v, size_t i);
const vig_json *vig_json_value(const vig_json *v, size_t i);

/* Array elements; 0/NULL when v is not an array. */
size_t vig_json_items(const vig_json *v);
const vig_json *vig_json_item(const vig_json *v, size_t i);

/* String content, or NULL when v is not a string. */
const char *vig_json_string(const vig_json *v);

/* Number value, or 0 when v is not a number. */
double vig_json_number(const vig_json *v);

#endif
