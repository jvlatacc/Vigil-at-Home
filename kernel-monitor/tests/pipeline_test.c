/* Reorder-window behavior with injected clocks: deterministic, no sleeping. */
#include "test_harness.h"

#include "../src/pipeline.h"

#include <string.h>

struct fake_clock {
	uint64_t mono_ns;
	struct timespec wall;
};

static void fake_reset(struct fake_clock *c)
{
	c->mono_ns = 1000000; /* anchor: mono 1 ms */
	c->wall.tv_sec = 1700000000;
	c->wall.tv_nsec = 0;
}

static uint64_t fake_mono(void *ctx)
{
	return ((struct fake_clock *)ctx)->mono_ns;
}

static struct timespec fake_wall(void *ctx)
{
	return ((struct fake_clock *)ctx)->wall;
}

static void advance(struct fake_clock *c, uint64_t ns)
{
	c->mono_ns += ns;
	c->wall.tv_sec += (time_t)(ns / 1000000000ULL);
	c->wall.tv_nsec += (long)(ns % 1000000000ULL);
	if (c->wall.tv_nsec >= 1000000000L) {
		c->wall.tv_sec++;
		c->wall.tv_nsec -= 1000000000L;
	}
}

struct sink {
	struct vig_event seen[64];
	struct timespec walls[64];
	size_t n;
};

static void sink_fn(void *user, const struct vig_event *e,
		    const struct timespec *wall)
{
	struct sink *s = user;

	s->seen[s->n] = *e;
	s->walls[s->n] = *wall;
	s->n++;
}

static struct vig_event mk(uint64_t mono_ns, uint32_t tgid, const char *comm)
{
	struct vig_event e;

	memset(&e, 0, sizeof e);
	e.kind = VIG_OP_EXEC;
	e.mono_ns = mono_ns;
	e.tgid = tgid;
	strcpy(e.comm, comm);
	snprintf((char *)e.payload, sizeof(e.payload), "%s", "/tmp/x");
	return e;
}

int main(void)
{
	struct fake_clock fc;
	struct vig_clocks clocks = { fake_mono, fake_wall, &fc };
	struct sink sink = { 0 };
	uint64_t win = 100 * 1000000ULL; /* 100 ms */

	/* 1. cross-CPU inversions come out ordered */
	{
		fake_reset(&fc);
		sink.n = 0;
		struct vig_pipeline *p = vig_pipeline_create(&clocks, win);

		vig_pipeline_set_emit(p, sink_fn, &sink);
		struct vig_event a = mk(3000000, 1, "late");
		struct vig_event b = mk(1000000, 2, "early");
		struct vig_event c = mk(2000000, 3, "middle");

		CHECK(vig_pipeline_push(p, &a) == 0);
		CHECK(vig_pipeline_push(p, &b) == 0);
		CHECK(vig_pipeline_push(p, &c) == 0);
		/* window still open: the newest stamp is 3 ms, the oldest 1 ms */
		CHECK(vig_pipeline_flush(p) == 0);
		CHECK(vig_pipeline_pending(p) == 3);
		/* the window closes 100 ms after the newest stamp (3 ms):
		 * from the 1 ms anchor, advance past 103 ms */
		advance(&fc, win + 2000000ULL); /* close the window */
		CHECK(vig_pipeline_flush(p) == 3);
		CHECK(sink.n == 3);
		CHECK(sink.seen[0].tgid == 2 && sink.seen[1].tgid == 3 &&
		      sink.seen[2].tgid == 1);
		for (size_t i = 1; i < sink.n; i++)
			CHECK(sink.seen[i - 1].mono_ns <= sink.seen[i].mono_ns);
		vig_pipeline_destroy(p);
	}

	/* 2. equal stamps stay FIFO */
	{
		fake_reset(&fc);
		sink.n = 0;
		struct vig_pipeline *p = vig_pipeline_create(&clocks, win);

		vig_pipeline_set_emit(p, sink_fn, &sink);
		struct vig_event a = mk(5000000, 10, "first");
		struct vig_event b = mk(5000000, 11, "second");

		CHECK(vig_pipeline_push(p, &a) == 0);
		CHECK(vig_pipeline_push(p, &b) == 0);
		/* stamps sit 4 ms past the anchor — advance past the newest
		 * stamp's window so both release */
		advance(&fc, win + 4000000ULL);
		CHECK(vig_pipeline_flush(p) == 2);
		CHECK(sink.n == 2);
		CHECK(sink.seen[0].tgid == 10 && sink.seen[1].tgid == 11);
		vig_pipeline_destroy(p);
	}

	/* 3. wall clock tracks the monotonic anchor: event 6 s after the
	 * anchor lands 6 s later on the wall clock */
	{
		fake_reset(&fc);
		sink.n = 0;
		struct vig_pipeline *p = vig_pipeline_create(&clocks, win);

		vig_pipeline_set_emit(p, sink_fn, &sink);
		struct vig_event a = mk(1000000ULL + 6000000000ULL, 5, "anchored");

		CHECK(vig_pipeline_push(p, &a) == 0);
		advance(&fc, win + 6000000000ULL); /* past the event's window */
		CHECK(vig_pipeline_flush(p) == 1);
		CHECK(sink.n == 1);
		CHECK(sink.walls[0].tv_sec == 1700000006);
		CHECK(sink.walls[0].tv_nsec == 0);
		vig_pipeline_destroy(p);
	}

	/* 4. a straggler stamped before the anchor clamps to the anchor wall
	 * (never regresses behind already-emitted wall times) */
	{
		fake_reset(&fc);
		sink.n = 0;
		struct vig_pipeline *p = vig_pipeline_create(&clocks, win);

		vig_pipeline_set_emit(p, sink_fn, &sink);
		struct vig_event anchor_age = mk(1000000, 5, "in-window");

		CHECK(vig_pipeline_push(p, &anchor_age) == 0);
		advance(&fc, win); /* anchor wall is now 100 ms later */
		struct vig_event straggler = mk(1000000, 9, "straggler");

		CHECK(vig_pipeline_push(p, &straggler) == 0);
		advance(&fc, win);
		CHECK(vig_pipeline_flush(p) == 2);
		CHECK(sink.n == 2);
		/* both clamp to a wall time at or before the current anchor */
		CHECK(sink.walls[0].tv_sec <= 1700000000);
		CHECK(sink.walls[1].tv_sec <= 1700000000);
		vig_pipeline_destroy(p);
	}

	/* 5. wall timestamps never regress across emissions */
	{
		fake_reset(&fc);
		sink.n = 0;
		struct vig_pipeline *p = vig_pipeline_create(&clocks, win);

		vig_pipeline_set_emit(p, sink_fn, &sink);
		for (uint64_t i = 0; i < 5; i++) {
			struct vig_event e = mk(2000000ULL + i * 3000000000ULL,
						(uint32_t)(100 + i), "seq");

			CHECK(vig_pipeline_push(p, &e) == 0);
		}
		advance(&fc, 3000000000ULL * 5 + win);
		CHECK(vig_pipeline_flush(p) == 5);
		for (size_t i = 1; i < sink.n; i++) {
			if (sink.walls[i - 1].tv_sec == sink.walls[i].tv_sec)
				CHECK(sink.walls[i - 1].tv_nsec <=
				      sink.walls[i].tv_nsec);
			else
				CHECK(sink.walls[i - 1].tv_sec <
				      sink.walls[i].tv_sec);
		}
		vig_pipeline_destroy(p);
	}

	TEST_END();
}
