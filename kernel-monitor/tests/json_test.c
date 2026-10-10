/* JSON rule-data parser: valid documents parse to the right types and
 * values; every malformation fails loudly with a reason and no value —
 * a rule file the daemon cannot fully understand must never load. */
#include "test_harness.h"

#include "../src/json.h"

#include <stdio.h>
#include <string.h>

int main(void)
{
	/* 1. a rule-shaped object with every value type */
	{
		char err[128];
		vig_json *v = vig_json_parse(
			"{\"name\":\"exec\",\"n\":5,\"neg\":-2.5,\"ok\":true,"
			"\"nope\":null,\"list\":[1,\"two\",false],"
			"\"nested\":{\"a\":[{\"b\":\"c\"}]}}",
			err, sizeof err);

		CHECK(v != NULL);
		if (!v)
			return 1;
		CHECK(err[0] == '\0');
		CHECK(vig_json_type_of(v) == VIG_JSON_OBJECT);
		CHECK(vig_json_members(v) == 7);

		const vig_json *name = vig_json_get(v, "name");

		CHECK(name && vig_json_type_of(name) == VIG_JSON_STRING);
		CHECK(name && strcmp(vig_json_string(name), "exec") == 0);

		const vig_json *n = vig_json_get(v, "n");

		CHECK(n && vig_json_type_of(n) == VIG_JSON_NUMBER);
		CHECK(n && vig_json_number(n) == 5.0);

		const vig_json *neg = vig_json_get(v, "neg");

		CHECK(neg && vig_json_number(neg) == -2.5);

		const vig_json *ok = vig_json_get(v, "ok");

		CHECK(ok && vig_json_type_of(ok) == VIG_JSON_BOOL);
		const vig_json *nope = vig_json_get(v, "nope");

		CHECK(nope && vig_json_type_of(nope) == VIG_JSON_NULL);

		const vig_json *list = vig_json_get(v, "list");

		CHECK(list && vig_json_type_of(list) == VIG_JSON_ARRAY);
		CHECK(list && vig_json_items(list) == 3);
		const vig_json *two = vig_json_item(list, 1);

		CHECK(two && vig_json_type_of(two) == VIG_JSON_STRING);
		CHECK(two && strcmp(vig_json_string(two), "two") == 0);

		const vig_json *nested = vig_json_get(v, "nested");

		CHECK(nested && vig_json_type_of(nested) == VIG_JSON_OBJECT);

		const vig_json *a = vig_json_get(nested, "a");

		CHECK(a && vig_json_items(a) == 1);
		const vig_json *zero = vig_json_item(a, 0);

		CHECK(zero && vig_json_type_of(zero) == VIG_JSON_OBJECT);
		CHECK(vig_json_get(zero, "b") != NULL);
		CHECK(vig_json_get(v, "missing") == NULL);
		CHECK(vig_json_members(list) == 0); /* not an object */
		CHECK(vig_json_items(v) == 0);	    /* not an array */
		CHECK(vig_json_string(n) == NULL);  /* not a string */
		CHECK(vig_json_number(name) == 0);  /* not a number */

		/* member order is document order */
		CHECK(strcmp(vig_json_key(v, 0), "name") == 0);
		CHECK(strcmp(vig_json_key(v, 1), "n") == 0);
		CHECK(vig_json_value(v, 1) == n);
		vig_json_free(v);
	}

	/* 2. string escapes decode; \u with a surrogate pair */
	{
		char err[128];
		vig_json *v = vig_json_parse("\"a\\\"b\\\\c\\u0041\\n\\ud83d\\ude00\"",
					     err, sizeof err);

		CHECK(v != NULL);
		if (!v)
			return 1;
		CHECK(strcmp(vig_json_string(v),
			     "a\"b\\cA\n\xf0\x9f\x98\x80") == 0);
		vig_json_free(v);
	}

	/* 3. whitespace tolerance and top-level scalars */
	{
		char err[128];
		vig_json *v = vig_json_parse("  [ 1 , 2 ]  ", err, sizeof err);

		CHECK(v != NULL);
		if (!v)
			return 1;
		CHECK(vig_json_items(v) == 2);
		CHECK(vig_json_number(vig_json_item(v, 1)) == 2.0);
		vig_json_free(v);

		v = vig_json_parse("true", err, sizeof err);
		CHECK(v && vig_json_type_of(v) == VIG_JSON_BOOL);
		vig_json_free(v);

		v = vig_json_parse("null", err, sizeof err);
		CHECK(v && vig_json_type_of(v) == VIG_JSON_NULL);
		vig_json_free(v);
	}

	/* 4. malformed input: NULL value, non-empty reason */
	{
		char err[128];
		vig_json *v = vig_json_parse("{\"name\": }", err, sizeof err);

		CHECK(v == NULL);
		CHECK(err[0] != '\0');

		v = vig_json_parse("\"abc", err, sizeof err);
		CHECK(v == NULL);
		CHECK(err[0] != '\0');

		v = vig_json_parse("\"a\\qb\"", err, sizeof err);
		CHECK(v == NULL);

		v = vig_json_parse("\"a\tb\"", err, sizeof err); /* raw tab */
		CHECK(v == NULL);

		v = vig_json_parse("{'single':1}", err, sizeof err);
		CHECK(v == NULL);

		v = vig_json_parse("5x", err, sizeof err);
		CHECK(v == NULL);

		v = vig_json_parse("", err, sizeof err);
		CHECK(v == NULL);

		/* trailing content after the document */
		v = vig_json_parse("{} x", err, sizeof err);
		CHECK(v == NULL);
		CHECK(strstr(err, "trailing") != NULL);

		/* truncated number */
		v = vig_json_parse("-", err, sizeof err);
		CHECK(v == NULL);
	}

	/* 5. depth limit: 32 nests parse, 40 fail */
	{
		char err[128];
		char doc[256];
		size_t used = 0;

		for (int i = 0; i < 40; i++)
			used += (size_t)snprintf(doc + used,
						 sizeof doc - used, "[");

		vig_json *v = vig_json_parse(doc, err, sizeof err);

		CHECK(v == NULL);

		used = 0;
		for (int i = 0; i < 32; i++)
			used += (size_t)snprintf(doc + used,
						 sizeof doc - used, "[");
		for (int i = 0; i < 32; i++)
			used += (size_t)snprintf(doc + used,
						 sizeof doc - used, "]");
		doc[used] = '\0';
		v = vig_json_parse(doc, err, sizeof err);
		CHECK(v != NULL);
		vig_json_free(v);
	}

	/* 6. deep nesting far beyond the rule vocabulary is bounded */
	{
		char err[128];
		char bomb[4096];

		for (size_t i = 0; i < sizeof bomb - 1; i++)
			bomb[i] = '[';
		bomb[sizeof bomb - 1] = '\0';

		vig_json *v = vig_json_parse(bomb, err, sizeof err);

		CHECK(v == NULL); /* must fail by depth, not crash */
	}

	TEST_END();
}
