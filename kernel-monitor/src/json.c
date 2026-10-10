#include "json.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* recursion is bounded so free() cannot overflow the stack either */
#define VIG_JSON_MAX_DEPTH 32

struct member {
	char *key; /* NULL in arrays */
	vig_json *val;
};

struct vig_json {
	vig_json_type type;
	char *str; /* VIG_JSON_STRING */
	double num; /* VIG_JSON_NUMBER */
	struct member *members; /* array and object members, in order */
	size_t n, cap;
};

struct parser {
	const char *p;
	unsigned line;
	char *err;
	size_t err_cap;
	int failed;
};

static void perr(struct parser *ps, const char *msg)
{
	if (ps->failed)
		return;
	ps->failed = 1;
	if (ps->err && ps->err_cap)
		snprintf(ps->err, ps->err_cap, "line %u: %s", ps->line, msg);
}

static void adv(struct parser *ps)
{
	if (*ps->p == '\n')
		ps->line++;
	ps->p++;
}

static void skip_ws(struct parser *ps)
{
	while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' ||
	       *ps->p == '\r')
		adv(ps);
}

static vig_json *node_new(struct parser *ps, vig_json_type type)
{
	vig_json *v = calloc(1, sizeof *v);

	if (!v) {
		perr(ps, "out of memory");
		return NULL;
	}
	v->type = type;
	return v;
}

static void member_add(struct parser *ps, vig_json *v, char *key,
		       vig_json *val)
{
	if (v->n == v->cap) {
		size_t cap = v->cap ? v->cap * 2 : 8;
		struct member *m = realloc(v->members, cap * sizeof *m);

		if (!m) {
			free(key);
			vig_json_free(val);
			perr(ps, "out of memory");
			return;
		}
		v->members = m;
		v->cap = cap;
	}
	v->members[v->n].key = key;
	v->members[v->n].val = val;
	v->n++;
}

void vig_json_free(vig_json *v)
{
	if (!v)
		return;
	for (size_t i = 0; i < v->n; i++) {
		free(v->members[i].key);
		vig_json_free(v->members[i].val);
	}
	free(v->members);
	free(v->str);
	free(v);
}

static int hex4(const char *s, unsigned *out)
{
	unsigned v = 0;

	for (int i = 0; i < 4; i++) {
		char c = s[i];
		unsigned d;

		if (c >= '0' && c <= '9')
			d = (unsigned)(c - '0');
		else if (c >= 'a' && c <= 'f')
			d = (unsigned)(c - 'a') + 10;
		else if (c >= 'A' && c <= 'F')
			d = (unsigned)(c - 'A') + 10;
		else
			return -1;
		v = v * 16 + d;
	}
	*out = v;
	return 0;
}

static size_t utf8_encode(unsigned cp, char *out)
{
	if (cp < 0x80) {
		out[0] = (char)cp;
		return 1;
	}
	if (cp < 0x800) {
		out[0] = (char)(0xC0 | (cp >> 6));
		out[1] = (char)(0x80 | (cp & 0x3F));
		return 2;
	}
	if (cp < 0x10000) {
		out[0] = (char)(0xE0 | (cp >> 12));
		out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
		out[2] = (char)(0x80 | (cp & 0x3F));
		return 3;
	}
	out[0] = (char)(0xF0 | (cp >> 18));
	out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
	out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
	out[3] = (char)(0x80 | (cp & 0x3F));
	return 4;
}

/* Consumes the opening quote; returns a decoded malloc'd string. */
static char *parse_string_raw(struct parser *ps)
{
	if (*ps->p != '"') {
		perr(ps, "expected a string");
		return NULL;
	}
	adv(ps);

	char *out = malloc(strlen(ps->p) + 1); /* decoded never grows */

	if (!out) {
		perr(ps, "out of memory");
		return NULL;
	}
	size_t o = 0;

	for (;;) {
		char c = *ps->p;

		if (c == '\0') {
			free(out);
			perr(ps, "unterminated string");
			return NULL;
		}
		if (c == '"') {
			adv(ps);
			out[o] = '\0';
			return out;
		}
		if ((unsigned char)c < 0x20) {
			free(out);
			perr(ps, "control character in string");
			return NULL;
		}
		if (c != '\\') {
			out[o++] = c;
			adv(ps);
			continue;
		}
		adv(ps); /* the backslash */
		char e = *ps->p;

		switch (e) {
		case '"': out[o++] = '"'; adv(ps); break;
		case '\\': out[o++] = '\\'; adv(ps); break;
		case '/': out[o++] = '/'; adv(ps); break;
		case 'b': out[o++] = '\b'; adv(ps); break;
		case 'f': out[o++] = '\f'; adv(ps); break;
		case 'n': out[o++] = '\n'; adv(ps); break;
		case 'r': out[o++] = '\r'; adv(ps); break;
		case 't': out[o++] = '\t'; adv(ps); break;
		case 'u': {
			adv(ps);
			unsigned cp;

			if (hex4(ps->p, &cp) != 0) {
				free(out);
				perr(ps, "bad \\u escape");
				return NULL;
			}
			for (int i = 0; i < 4; i++)
				adv(ps);
			if (cp >= 0xD800 && cp <= 0xDBFF) {
				/* a high surrogate must be paired */
				if (ps->p[0] != '\\' || ps->p[1] != 'u') {
					free(out);
					perr(ps, "lone high surrogate");
					return NULL;
				}
				adv(ps);
				adv(ps);
				unsigned lo;

				if (hex4(ps->p, &lo) != 0 ||
				    lo < 0xDC00 || lo > 0xDFFF) {
					free(out);
					perr(ps, "lone high surrogate");
					return NULL;
				}
				for (int i = 0; i < 4; i++)
					adv(ps);
				cp = 0x10000 + ((cp - 0xD800) << 10) +
				     (lo - 0xDC00);
			} else if (cp >= 0xDC00 && cp <= 0xDFFF) {
				free(out);
				perr(ps, "lone low surrogate");
				return NULL;
			}
			o += utf8_encode(cp, out + o);
			break;
		}
		default:
			free(out);
			perr(ps, "bad escape");
			return NULL;
		}
	}
}

static vig_json *parse_value(struct parser *ps, int depth);

static vig_json *parse_container(struct parser *ps, int depth, char open,
				 char close)
{
	int is_object = open == '{';
	vig_json *v = node_new(ps, is_object ? VIG_JSON_OBJECT :
						     VIG_JSON_ARRAY);

	if (!v)
		return NULL;
	adv(ps); /* the opening bracket */
	skip_ws(ps);
	if (*ps->p == close) {
		adv(ps);
		return v;
	}
	for (;;) {
		char *key = NULL;

		if (is_object) {
			skip_ws(ps);
			key = parse_string_raw(ps);
			if (!key)
				goto fail;
			skip_ws(ps);
			if (*ps->p != ':') {
				free(key);
				perr(ps, "expected ':'");
				goto fail;
			}
			adv(ps);
		}
		vig_json *val = parse_value(ps, depth + 1);

		if (!val) {
			free(key);
			goto fail;
		}
		member_add(ps, v, key, val);
		if (ps->failed)
			goto fail;
		skip_ws(ps);
		if (*ps->p == ',') {
			adv(ps);
			continue;
		}
		if (*ps->p == close) {
			adv(ps);
			return v;
		}
		perr(ps, is_object ? "expected ',' or '}'" :
				     "expected ',' or ']'");
		goto fail;
	}
fail:
	vig_json_free(v);
	return NULL;
}

static vig_json *parse_number(struct parser *ps)
{
	const char *s = ps->p;

	if (*ps->p == '-')
		adv(ps);
	if (*ps->p == '0') {
		adv(ps);
	} else if (*ps->p >= '1' && *ps->p <= '9') {
		while (*ps->p >= '0' && *ps->p <= '9')
			adv(ps);
	} else {
		perr(ps, "bad number");
		return NULL;
	}
	if (*ps->p == '.') {
		adv(ps);
		if (!(*ps->p >= '0' && *ps->p <= '9')) {
			perr(ps, "bad number fraction");
			return NULL;
		}
		while (*ps->p >= '0' && *ps->p <= '9')
			adv(ps);
	}
	if (*ps->p == 'e' || *ps->p == 'E') {
		adv(ps);
		if (*ps->p == '+' || *ps->p == '-')
			adv(ps);
		if (!(*ps->p >= '0' && *ps->p <= '9')) {
			perr(ps, "bad number exponent");
			return NULL;
		}
		while (*ps->p >= '0' && *ps->p <= '9')
			adv(ps);
	}

	size_t len = (size_t)(ps->p - s);
	char *span = malloc(len + 1);

	if (!span) {
		perr(ps, "out of memory");
		return NULL;
	}
	memcpy(span, s, len);
	span[len] = '\0';

	vig_json *v = node_new(ps, VIG_JSON_NUMBER);

	if (v)
		v->num = strtod(span, NULL); /* C locale: '.' decimal point */
	free(span);
	return v;
}

static int literal(struct parser *ps, const char *lit)
{
	if (strncmp(ps->p, lit, strlen(lit)) != 0) {
		perr(ps, "invalid literal");
		return -1;
	}
	for (size_t i = 0; i < strlen(lit); i++)
		adv(ps);
	return 0;
}

static vig_json *parse_value(struct parser *ps, int depth)
{
	if (depth > VIG_JSON_MAX_DEPTH) {
		perr(ps, "nested too deeply");
		return NULL;
	}
	skip_ws(ps);
	switch (*ps->p) {
	case '{':
		return parse_container(ps, depth, '{', '}');
	case '[':
		return parse_container(ps, depth, '[', ']');
	case '"': {
		char *s = parse_string_raw(ps);

		if (!s)
			return NULL;
		vig_json *v = node_new(ps, VIG_JSON_STRING);

		if (!v) {
			free(s);
			return NULL;
		}
		v->str = s;
		return v;
	}
	case 't':
		if (literal(ps, "true") != 0)
			return NULL;
		return node_new(ps, VIG_JSON_BOOL);
	case 'f':
		if (literal(ps, "false") != 0)
			return NULL;
		return node_new(ps, VIG_JSON_BOOL);
	case 'n':
		if (literal(ps, "null") != 0)
			return NULL;
		return node_new(ps, VIG_JSON_NULL);
	default:
		if (*ps->p == '-' || (*ps->p >= '0' && *ps->p <= '9'))
			return parse_number(ps);
		perr(ps, "unexpected character");
		return NULL;
	}
}

vig_json *vig_json_parse(const char *text, char *err, size_t err_cap)
{
	struct parser ps = { text, 1, err, err_cap, 0 };

	if (err && err_cap)
		err[0] = '\0';

	vig_json *v = parse_value(&ps, 0);

	if (!v)
		return NULL;
	skip_ws(&ps);
	if (*ps.p != '\0') {
		perr(&ps, "trailing content after the document");
		vig_json_free(v);
		return NULL;
	}
	return v;
}

vig_json_type vig_json_type_of(const vig_json *v)
{
	return v ? v->type : VIG_JSON_NULL;
}

const vig_json *vig_json_get(const vig_json *v, const char *key)
{
	if (!v || v->type != VIG_JSON_OBJECT)
		return NULL;
	for (size_t i = 0; i < v->n; i++)
		if (strcmp(v->members[i].key, key) == 0)
			return v->members[i].val;
	return NULL;
}

size_t vig_json_members(const vig_json *v)
{
	return v && v->type == VIG_JSON_OBJECT ? v->n : 0;
}

const char *vig_json_key(const vig_json *v, size_t i)
{
	return v && v->type == VIG_JSON_OBJECT && i < v->n ?
		       v->members[i].key :
		       NULL;
}

const vig_json *vig_json_value(const vig_json *v, size_t i)
{
	return v && (v->type == VIG_JSON_OBJECT || v->type == VIG_JSON_ARRAY) &&
		       i < v->n ?
		       v->members[i].val :
		       NULL;
}

size_t vig_json_items(const vig_json *v)
{
	return v && v->type == VIG_JSON_ARRAY ? v->n : 0;
}

const vig_json *vig_json_item(const vig_json *v, size_t i)
{
	return v && v->type == VIG_JSON_ARRAY && i < v->n ?
		       v->members[i].val :
		       NULL;
}

const char *vig_json_string(const vig_json *v)
{
	return v && v->type == VIG_JSON_STRING ? v->str : NULL;
}

double vig_json_number(const vig_json *v)
{
	return v && v->type == VIG_JSON_NUMBER ? v->num : 0;
}
