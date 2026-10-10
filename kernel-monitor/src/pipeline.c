#include "pipeline.h"

#include <stdlib.h>
#include <string.h>

struct node {
	struct vig_event e;
	uint64_t seq; /* tie-breaker: FIFO for equal stamps */
};

struct vig_pipeline {
	struct node *heap;
	size_t size, cap;
	uint64_t window_ns;
	uint64_t high_water; /* newest mono stamp seen */
	uint64_t seq;
	uint64_t anchor_mono_ns;
	struct timespec anchor_wall;
	struct vig_clocks clocks;
	vig_emit_fn emit;
	void *emit_user;
};

static uint64_t now_mono(const struct vig_pipeline *p)
{
	return p->clocks.now_mono_ns(p->clocks.ctx);
}

static void sift_up(struct vig_pipeline *p, size_t i)
{
	while (i > 0) {
		size_t parent = (i - 1) / 2;
		struct node a = p->heap[i], b = p->heap[parent];

		if (a.e.mono_ns > b.e.mono_ns ||
		    (a.e.mono_ns == b.e.mono_ns && a.seq > b.seq))
			break;
		p->heap[i] = b;
		p->heap[parent] = a;
		i = parent;
	}
}

static void sift_down(struct vig_pipeline *p, size_t i)
{
	for (;;) {
		size_t l = 2 * i + 1, r = l + 1, m = i;

		if (l < p->size) {
			struct node *a = &p->heap[l], *b = &p->heap[m];

			if (a->e.mono_ns < b->e.mono_ns ||
			    (a->e.mono_ns == b->e.mono_ns && a->seq < b->seq))
				m = l;
		}
		if (r < p->size) {
			struct node *a = &p->heap[r], *b = &p->heap[m];

			if (a->e.mono_ns < b->e.mono_ns ||
			    (a->e.mono_ns == b->e.mono_ns && a->seq < b->seq))
				m = r;
		}
		if (m == i)
			break;
		struct node t = p->heap[i];

		p->heap[i] = p->heap[m];
		p->heap[m] = t;
		i = m;
	}
}

struct vig_pipeline *vig_pipeline_create(const struct vig_clocks *clocks,
					 uint64_t window_ns)
{
	struct vig_pipeline *p = calloc(1, sizeof(*p));

	if (!p)
		return NULL;
	p->clocks = *clocks;
	p->window_ns = window_ns;
	p->cap = 4096;
	p->heap = malloc(p->cap * sizeof(*p->heap));
	if (!p->heap) {
		free(p);
		return NULL;
	}
	vig_pipeline_reanchor(p);
	return p;
}

void vig_pipeline_destroy(struct vig_pipeline *p)
{
	if (!p)
		return;
	free(p->heap);
	free(p);
}

void vig_pipeline_set_emit(struct vig_pipeline *p, vig_emit_fn fn, void *user)
{
	p->emit = fn;
	p->emit_user = user;
}

void vig_pipeline_reanchor(struct vig_pipeline *p)
{
	p->anchor_mono_ns = now_mono(p);
	p->anchor_wall = p->clocks.now_wall(p->clocks.ctx);
}

int vig_pipeline_push(struct vig_pipeline *p, const struct vig_event *e)
{
	if (p->size == p->cap) {
		size_t cap = p->cap * 2;
		struct node *heap = realloc(p->heap, cap * sizeof(*p->heap));

		if (!heap)
			return -1;
		p->heap = heap;
		p->cap = cap;
	}

	struct node n = { *e, p->seq++ };

	p->heap[p->size++] = n;
	sift_up(p, p->size - 1);
	if (e->mono_ns > p->high_water)
		p->high_water = e->mono_ns;
	return 0;
}

static void wall_for(const struct vig_pipeline *p, uint64_t mono_ns,
		     struct timespec *out)
{
	uint64_t delta = mono_ns > p->anchor_mono_ns ?
				 mono_ns - p->anchor_mono_ns :
				 0; /* stragglers pre-anchor clamp to anchor */

	*out = p->anchor_wall;
	out->tv_sec += (time_t)(delta / 1000000000ULL);
	out->tv_nsec += (long)(delta % 1000000000ULL);
	if (out->tv_nsec >= 1000000000L) {
		out->tv_sec += 1;
		out->tv_nsec -= 1000000000L;
	}
}

size_t vig_pipeline_flush(struct vig_pipeline *p)
{
	size_t emitted = 0;

	while (p->size > 0) {
		struct node *root = &p->heap[0];
		uint64_t now = now_mono(p);
		uint64_t release_at = root->e.mono_ns + p->window_ns;

		if (p->high_water < release_at && now < release_at)
			break;

		struct vig_event e = root->e;
		struct timespec wall;

		wall_for(p, e.mono_ns, &wall);
		p->heap[0] = p->heap[--p->size];
		sift_down(p, 0);
		emitted++;
		if (p->emit)
			p->emit(p->emit_user, &e, &wall);
	}
	return emitted;
}

size_t vig_pipeline_pending(const struct vig_pipeline *p)
{
	return p->size;
}
