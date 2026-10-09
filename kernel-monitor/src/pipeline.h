/* The event pipeline: push ring-buffer records in, get them out in monotonic
 * order after a fixed reorder window, anchored to wall-clock time.
 *
 * Ordering rule (deterministic, injectable clocks for tests): a record is
 * emitted when the newest stamp seen so far has moved `window_ns` past it, or
 * when wall-time has — whichever comes first. That bounds latency at one
 * window and guarantees the emitted sequence never regresses on mono_ns. */
#ifndef VIG_PIPELINE_H
#define VIG_PIPELINE_H

#include "event.h"

#include <stddef.h>
#include <stdint.h>
#include <time.h>

#define VIG_REORDER_WINDOW_MS 100

struct vig_clocks {
	uint64_t (*now_mono_ns)(void *ctx);
	struct timespec (*now_wall)(void *ctx);
	void *ctx;
};

typedef void (*vig_emit_fn)(void *user, const struct vig_event *e,
			    const struct timespec *wall);

struct vig_pipeline;

struct vig_pipeline *vig_pipeline_create(const struct vig_clocks *clocks,
					 uint64_t window_ns);
void vig_pipeline_destroy(struct vig_pipeline *p);

/* The emit callback runs, in order, for every record the window releases. */
void vig_pipeline_set_emit(struct vig_pipeline *p, vig_emit_fn fn, void *user);

/* Re-capture the monotonic↔wall anchor; call periodically so wall timestamps
 * track clock slew over a long run. */
void vig_pipeline_reanchor(struct vig_pipeline *p);

/* Queue a record. Returns 0, or -1 when the pipeline is out of memory. */
int vig_pipeline_push(struct vig_pipeline *p, const struct vig_event *e);

/* Release every record whose window has passed; returns how many. */
size_t vig_pipeline_flush(struct vig_pipeline *p);

size_t vig_pipeline_pending(const struct vig_pipeline *p);

#endif
