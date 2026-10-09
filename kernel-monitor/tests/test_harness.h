/* Minimal test harness: no dependencies, asserts with file/line output. */
#ifndef VIG_TEST_HARNESS_H
#define VIG_TEST_HARNESS_H

#include <stdio.h>
#include <stdlib.h>

static int vig_tests_run, vig_tests_failed;

#define CHECK(cond) do { \
	if (!(cond)) { \
		fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
		vig_tests_failed++; \
	} \
} while (0)

#define TEST_END() do { \
	vig_tests_run++; \
	if (vig_tests_failed) { \
		printf("FAIL %s (%d checks failed)\n", __FILE__, vig_tests_failed); \
		return 1; \
	} \
	printf("ok %s\n", __FILE__); \
	return 0; \
} while (0)

#endif
