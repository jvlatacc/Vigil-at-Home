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

	const char *hooks[16];
	size_t hooks_n = 0;
	char feat_btf[32], feat_lsm[48], feat_kpm[40], hook_exec[48],
		hook_fork[48];

	snprintf(feat_btf, sizeof feat_btf, "feature/btf=%s",
		 f.btf_present ? "yes" : "no");
	snprintf(feat_lsm, sizeof feat_lsm, "feature/bpf-lsm-attach=%s",
		 f.lsm_prog_supported && f.lsm_bpf_active ? "yes" : "no");
	snprintf(feat_kpm, sizeof feat_kpm, "feature/kprobe-multi=%s",
		 f.kprobe_multi ? "yes" : "no");
	hooks[hooks_n++] = feat_btf;
	hooks[hooks_n++] = feat_lsm;
	hooks[hooks_n++] = feat_kpm;

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

	/* tracepoint programs auto-attach from their SEC names; failure marks
	 * the monitor degraded — a missing hook is reported, never faked */
	bool degraded = false;

	if (vigil_bpf__attach(skel) != 0) {
		fprintf(stderr, "vigil-kernel-monitor: attach failed: %s\n",
			strerror(errno));
		degraded = true;
	} else {
		snprintf(hook_exec, sizeof hook_exec, "tracepoint/sched/sched_process_exec");
		snprintf(hook_fork, sizeof hook_fork, "tracepoint/sched/sched_process_fork");
		hooks[hooks_n++] = hook_exec;
		hooks[hooks_n++] = hook_fork;
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
