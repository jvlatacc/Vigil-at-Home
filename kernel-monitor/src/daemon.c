/* Vigil kernel monitor — userspace daemon (core).
 *
 * Loads the CO-RE eBPF object, consumes the ring buffer, reorders events on
 * their monotonic stamp inside a 100 ms window, anchors them to wall-clock
 * time, appends the JSONL operations index, and emits each record as an RFC
 * 5424 VIGOP message to /dev/log — rsyslog owns delivery from there. Rule
 * evaluation and VIGALERT messages land with the rules PR; the core emits
 * VIGOP only. */
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <bpf/libbpf.h>

#include "attach.h"
#include "event.h"
#include "feature_probe.h"
#include "health.h"
#include "index.h"
#include "pipeline.h"
#include "syslog_emit.h"
#include "util.h"

#include "vigil.skel.h" /* generated: bpftool gen skeleton */

#define VIG_HEALTH_TICK_S 10
#define VIG_HEALTH_HEARTBEAT_S 60
#define VIG_DROP_ALERT_DELTA 1000

static volatile sig_atomic_t g_stop;

static void on_signal(int sig)
{
	g_stop = 1;
	(void)sig;
}

static uint64_t real_now_mono_ns(void *ctx)
{
	struct timespec ts;

	(void)ctx;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

static struct timespec real_now_wall(void *ctx)
{
	struct timespec ts;

	(void)ctx;
	clock_gettime(CLOCK_REALTIME, &ts);
	return ts;
}

struct emit_ctx {
	struct vig_index *index;
	struct vig_syslog *slog;
	const char *hostname;
};

static void on_emit(void *user, const struct vig_event *e,
		    const struct timespec *wall)
{
	struct emit_ctx *c = user;
	char line[VIG_INDEX_LINE_MAX];

	if (vig_index_line(e, wall, line, sizeof line) < 0) {
		fprintf(stderr, "vigil-kernel-monitor: index line did not fit, dropped\n");
		return;
	}
	if (vig_index_append(c->index, line) != 0)
		fprintf(stderr, "vigil-kernel-monitor: index append failed: %s\n",
			strerror(errno));
	vig_syslog_emit(c->slog, VIG_SYSLOG_PRI_OP, VIG_SYSLOG_MSGID_OP, e,
			wall, c->hostname);
}

static int on_ring(void *user, void *data, size_t len)
{
	struct vig_pipeline *pipeline = user;

	/* layout drift between object and daemon would be a build bug; the
	 * static asserts hold the two sides together */
	if (len != sizeof(struct vig_event))
		return 0;
	vig_pipeline_push(pipeline, (const struct vig_event *)data);
	return 0;
}

static uint64_t read_dropped(struct vigil_bpf *skel)
{
	uint64_t v = 0, zero = 0;

	/* userspace side of the drop-counter map (libbpf 1.x API) */
	if (bpf_map__lookup_elem(skel->maps.dropped, &zero, sizeof zero, &v,
				 sizeof v, 0) != 0)
		return 0;
	return v;
}

static void usage(FILE *out)
{
	fprintf(out,
		"usage: vigil-kernel-monitor [--index-dir DIR] [--syslog-path PATH]"
		" [--window-ms MS]\n");
}

/* Attach bookkeeping. Links must outlive main()'s loop, so they live in a
 * pool; the kernel detaches everything when the process exits anyway. */
#define VIG_LINKS_MAX 32
#define VIG_HOOKS_MAX 32
#define VIG_HOOK_NAME_MAX 56

static struct bpf_link *g_links[VIG_LINKS_MAX];
static size_t g_links_n;

static bool attach_program(struct vigil_bpf *skel, const char *prog_name)
{
	struct bpf_program *p = bpf_object__find_program_by_name(skel->obj, prog_name);
	struct bpf_link *l;

	if (!p)
		return false;
	l = bpf_program__attach(p); /* attach type comes from the SEC name */
	if (!l)
		return false;
	if (g_links_n < VIG_LINKS_MAX)
		g_links[g_links_n++] = l;
	else
		bpf_link__destroy(l);
	return true;
}

/* Hook naming for the health line, appended in attach order. */
struct vig_hook_report {
	char (*bufs)[VIG_HOOK_NAME_MAX];
	const char **hooks;
	size_t *n;
	size_t max;
};

static void report_hook(struct vig_hook_report *r, const char *fmt, const char *a)
{
	if (*r->n >= r->max)
		return;
	snprintf(r->bufs[*r->n], VIG_HOOK_NAME_MAX, fmt, a);
	r->hooks[*r->n] = r->bufs[*r->n];
	(*r->n)++;
}

/* Attach one tracepoint program; false = the hook is missing and the
 * monitor runs degraded. */
static bool attach_tracepoint(struct vigil_bpf *skel, const char *prog_name,
			      const char *label, struct vig_hook_report *r)
{
	if (!attach_program(skel, prog_name)) {
		fprintf(stderr, "vigil-kernel-monitor: %s attach failed\n",
			label);
		return false;
	}
	report_hook(r, "%s", label);
	return true;
}

/* What happened to one LSM-class hook. */
enum vig_attach_out {
	VIG_ATTACHED = 1,
	VIG_ATTACH_MISSING, /* neither mechanism attached */
	VIG_ATTACH_ABSENT,  /* hook not in this object (lands with its commit) */
};

/* Attach one LSM-class hook per the plan: the LSM program when planned and
 * present, else its kprobe twin. The health line names the mechanism that
 * actually serves the hook — "lsm/<hook>" or "kprobe/security_<hook>" — so
 * a fallback entry names the missing LSM hook class by contrast. */
static enum vig_attach_out attach_planned_hook(struct vigil_bpf *skel,
					       const struct vig_hook_plan *h,
					       struct vig_hook_report *r)
{
	char pname[64];
	bool have_primary, have_fb;

	snprintf(pname, sizeof pname, "vig_lsm_%s", h->hook);
	have_primary = bpf_object__find_program_by_name(skel->obj, pname) != NULL;
	snprintf(pname, sizeof pname, "vig_kp_%s", h->hook);
	have_fb = bpf_object__find_program_by_name(skel->obj, pname) != NULL;

	if (!have_primary && !have_fb)
		return VIG_ATTACH_ABSENT;

	snprintf(pname, sizeof pname, "vig_lsm_%s", h->hook);
	if (h->mode == VIG_HOOK_LSM && have_primary &&
	    attach_program(skel, pname)) {
		report_hook(r, "lsm/%s", h->hook);
		return VIG_ATTACHED;
	}

	snprintf(pname, sizeof pname, "vig_kp_%s", h->hook);
	if (have_fb && attach_program(skel, pname)) {
		report_hook(r, "kprobe/%s", h->fb_sym);
		return VIG_ATTACHED;
	}

	fprintf(stderr, "vigil-kernel-monitor: hook %s: no mechanism attached\n",
		h->hook);
	report_hook(r, "missing/lsm/%s", h->hook);
	return VIG_ATTACH_MISSING;
}

/* Emit the feature matrix as the startup monitor.health record. */
static void emit_health(struct vig_pipeline *pipeline, size_t hooks_n,
			const char *const *hooks, uint64_t dropped, bool degraded)
{
	struct vig_event e;

	vig_health_event(&e, real_now_mono_ns(NULL), (uint32_t)getpid(),
			 dropped, hooks, hooks_n, degraded);
	vig_pipeline_push(pipeline, &e);
	vig_pipeline_flush(pipeline);
}

int main(int argc, char **argv)
{
	const char *index_dir = VIG_INDEX_DIR_DEFAULT;
	const char *syslog_path = "/dev/log";
	uint64_t window_ms = VIG_REORDER_WINDOW_MS;

	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--index-dir") && i + 1 < argc) {
			index_dir = argv[++i];
		} else if (!strcmp(argv[i], "--syslog-path") && i + 1 < argc) {
			syslog_path = argv[++i];
		} else if (!strcmp(argv[i], "--window-ms") && i + 1 < argc) {
			window_ms = strtoull(argv[++i], NULL, 10);
		} else if (!strcmp(argv[i], "--help")) {
			usage(stdout);
			return 0;
		} else {
			usage(stderr);
			return 2;
		}
	}

	struct sigaction sa;

	memset(&sa, 0, sizeof sa);
	sa.sa_handler = on_signal;
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);

	struct vig_features f;

	if (vig_features_probe(&f) != 0) {
		fprintf(stderr, "vigil-kernel-monitor: feature probe failed\n");
		return 2;
	}

	if (vig_mkdir_p(index_dir, 0755) != 0) {
		fprintf(stderr, "vigil-kernel-monitor: cannot create %s: %s\n",
			index_dir, strerror(errno));
		return 1;
	}

	struct vig_index *index = vig_index_open(index_dir, VIG_INDEX_BASE_NAME,
						 VIG_INDEX_MAX_BYTES_DEFAULT,
						 VIG_INDEX_KEEP_DEFAULT);

	if (!index) {
		fprintf(stderr, "vigil-kernel-monitor: cannot open index in %s: %s\n",
			index_dir, strerror(errno));
		return 1;
	}

	char hostname[256];

	if (gethostname(hostname, sizeof hostname) != 0)
		strcpy(hostname, "localhost");

	struct emit_ctx ectx = { index, vig_syslog_open(syslog_path), hostname };
	struct vig_clocks clocks = { real_now_mono_ns, real_now_wall, NULL };
	struct vig_pipeline *pipeline =
		vig_pipeline_create(&clocks, window_ms * 1000000ULL);

	if (!ectx.slog || !pipeline) {
		fprintf(stderr, "vigil-kernel-monitor: init failed\n");
		vig_index_close(index);
		vig_syslog_close(ectx.slog);
		vig_pipeline_destroy(pipeline);
		return 1;
	}
	vig_pipeline_set_emit(pipeline, on_emit, &ectx);

	char hook_bufs[VIG_HOOKS_MAX][VIG_HOOK_NAME_MAX];
	const char *hooks[VIG_HOOKS_MAX];
	size_t hooks_n = 0;
	struct vig_hook_report report = { hook_bufs, hooks, &hooks_n,
					  VIG_HOOKS_MAX };
	char feat_btf[32], feat_lsm[48], feat_kpm[40];

	snprintf(feat_btf, sizeof feat_btf, "feature/btf=%s",
		 f.btf_present ? "yes" : "no");
	snprintf(feat_lsm, sizeof feat_lsm, "feature/bpf-lsm-attach=%s",
		 f.lsm_prog_supported && f.lsm_bpf_active ? "yes" : "no");
	snprintf(feat_kpm, sizeof feat_kpm, "feature/kprobe-multi=%s",
		 f.kprobe_multi ? "yes" : "no");
	report_hook(&report, "%s", feat_btf);
	report_hook(&report, "%s", feat_lsm);
	report_hook(&report, "%s", feat_kpm);

	/* BTF is the one non-negotiable: without it CO-RE cannot relocate and
	 * a half-attached monitor would lie about what it saw. Refuse to run
	 * rather than guess — the health line records the failure. */
	if (!f.btf_present || !f.ringbuf) {
		fprintf(stderr, "vigil-kernel-monitor: refusing to run: %s\n",
			!f.btf_present ?
				"no kernel BTF at /sys/kernel/btf/vmlinux (CO-RE needs it)" :
				"kernel too old for the BPF ring buffer (5.8+ required)");
		emit_health(pipeline, hooks_n, hooks, 0, true);
		vig_index_close(index);
		vig_syslog_close(ectx.slog);
		vig_pipeline_destroy(pipeline);
		return 2;
	}

	struct vigil_bpf *skel = vigil_bpf__open_and_load();

	if (!skel) {
		fprintf(stderr, "vigil-kernel-monitor: failed to load the eBPF object: %s\n",
			strerror(errno));
		vig_index_close(index);
		vig_syslog_close(ectx.slog);
		vig_pipeline_destroy(pipeline);
		return 2;
	}

	/* Explicit, plan-driven attach: the probe picked the mechanism per
	 * hook; every attachment is named in the health line; a missing hook
	 * is reported, never faked. LSM-class hooks land with their commits —
	 * until then the plan finds no programs for them and skips them. */
	bool degraded = false;

	degraded |= !attach_tracepoint(skel, "on_exec",
				       "tracepoint/sched/sched_process_exec",
				       &report);
	degraded |= !attach_tracepoint(skel, "on_fork",
				       "tracepoint/sched/sched_process_fork",
				       &report);

	struct vig_attach_plan plan;

	vig_attach_plan_build(f.lsm_prog_supported && f.lsm_bpf_active, &plan);
	for (size_t i = 0; i < plan.hooks_n; i++) {
		if (attach_planned_hook(skel, &plan.hooks[i], &report) ==
		    VIG_ATTACH_MISSING)
			degraded = true;
	}

	struct ring_buffer *rb =
		ring_buffer__new(bpf_map__fd(skel->maps.events), on_ring,
				 pipeline, NULL);

	if (!rb) {
		fprintf(stderr, "vigil-kernel-monitor: ring buffer setup failed\n");
		vigil_bpf__destroy(skel);
		vig_index_close(index);
		vig_syslog_close(ectx.slog);
		vig_pipeline_destroy(pipeline);
		return 1;
	}

	emit_health(pipeline, hooks_n, hooks, 0, degraded);

	uint64_t reported_dropped = 0;
	time_t last_tick = time(NULL), last_reanchor = last_tick;
	time_t last_health = last_tick;

	while (!g_stop) {
		int err = ring_buffer__poll(rb, 50 /* ms, in two halves */);

		if (err == -EINTR)
			continue;
		if (err < 0 && err != -EAGAIN) {
			fprintf(stderr, "vigil-kernel-monitor: ring poll error %d\n",
				err);
			break;
		}
		vig_pipeline_flush(pipeline);

		time_t now = time(NULL);

		if (now - last_tick >= VIG_HEALTH_TICK_S) {
			uint64_t dropped = read_dropped(skel);

			/* health line when the drop counter grew by the alert
			 * delta, or on the heartbeat so a silent monitor is
			 * itself visible */
			if (dropped - reported_dropped >= VIG_DROP_ALERT_DELTA ||
			    now - last_health >= VIG_HEALTH_HEARTBEAT_S) {
				emit_health(pipeline, hooks_n, hooks, dropped,
					    degraded);
				reported_dropped = dropped;
				last_health = now;
			}
			last_tick = now;
		}
		if (now - last_reanchor >= 30) {
			vig_pipeline_reanchor(pipeline);
			last_reanchor = now;
		}
	}

	/* drain: whatever the window still holds gets flushed with the wall
	 * clock well past every release deadline */
	for (int i = 0; i < 20 && vig_pipeline_pending(pipeline) > 0; i++) {
		vig_pipeline_flush(pipeline);
		usleep(10000);
	}

	ring_buffer__free(rb);
	vigil_bpf__destroy(skel);
	vig_index_close(index);
	vig_syslog_close(ectx.slog);
	vig_pipeline_destroy(pipeline);
	return 0;
}
