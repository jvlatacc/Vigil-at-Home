# The appliance

The appliance is an optional, self-hosted virtual machine that gives your SOC
network visibility the desktop app can't have: it sits where your traffic is,
not on the machine being watched. A single qcow2 image runs one service that
accepts NetFlow (from a firewall, a router, or a softflowd box) on UDP and the
`osqueryd.results.log` lines your Vigil endpoints already write locally over an
authenticated HTTP endpoint, spools both to disk, and uploads them as gzipped
NDJSON to any S3-compatible bucket — a SeaweedFS gateway on your LAN, or AWS S3,
or anything else that speaks SigV4 with path-style addressing.

The desktop app itself still has no server and no account: the appliance is the
one self-hosted component, it runs on your own hardware, and nothing goes to any
provider. Deploy it when you want off-box visibility; skip it and Vigil works
exactly as it did before.

## What it is and what it is not

A deployed appliance is one Debian VM (built for amd64) running one systemd
service, `vigil-appliance.service`, with the whole configuration surface in a
single environment file that cloud-init writes at first boot.

- **Two ways in.** NetFlow v5, v9 and IPFIX arrive as UDP datagrams on port 2550. Vigil endpoint records arrive as NDJSON lines posted to
  `POST /ingest` on TCP port 2551 with a bearer token. Both paths normalize
  into one record shape, `vigil.flow.v1`, before anything touches disk.
- **One way out.** Closed spool segments upload to
  `<endpoint>/<bucket>/<prefix>/<source>/YYYY/MM/DD/HH/seg-<startMs>-<seq>.ndjson.gz`
  (UTC), with `Content-Type: application/x-ndjson` and `Content-Encoding:
gzip`. Upload is at-least-once: a spool file is deleted only after the
  bucket answered 2xx.
- **It is not** a dashboard, a query engine or an alerting system — it is a
  forwarder. Query the bucket directly (DuckDB reads the layout above as-is).
  It does not expire objects either; retention is your bucket's lifecycle
  rules. It never modifies Vigil: endpoints forward what they already wrote,
  using the recipe below, with no Vigil-side change.
- **Plaintext HTTP is a LAN assumption.** The ingest endpoint authenticates
  with a bearer token but does not do TLS. On an untrusted network, put a
  TLS-terminating reverse proxy in front of port 2551 and point forwarders at
  the proxy instead.

## Get the image

Every release carries `vigil-appliance-<version>.qcow2` and a `SHA256SUMS`
file as release assets (drafts until a maintainer publishes them). Download
both and verify:

```bash
sha256sum -c SHA256SUMS
# vigil-appliance-0.1.0-alpha.3.qcow2: OK
```

### Build it yourself

You need `packer` (1.9+), `qemu-system-x86_64`, `ssh-keygen`, `node` and
`curl` on the build host. The build boots the pinned Debian 12 cloud image,
installs a checksum-verified Node.js 22 runtime, bundles the collector, and
strips every build credential before shutting down. On a host without
`/dev/kvm` it falls back to TCG software emulation and warns you — expect tens
of minutes on emulated boot.

```bash
pnpm install
apps/appliance/scripts/build.sh
# → apps/appliance/packer/output/vigil-appliance-<version>.qcow2 + SHA256SUMS
```

The version defaults to the desktop app's version; pass one explicitly
(`apps/appliance/scripts/build.sh 0.1.0`) to name the image yourself. Base
image, Node runtime and every provision step are checksum-pinned — see
[the appliance README](../apps/appliance/README.md) for where each pin lives.

## Prepare the bucket

The bucket must exist before the appliance starts (the service will not
create it). With a SeaweedFS gateway — the reference sink — create the bucket
and a credential pair scoped to it in `weed shell`:

```bash
weed shell <<'EOF'
s3.bucket.create -name=vigil-flows
s3.configure -user=vigil \
  -access_key=my-access-key-id \
  -secret_key=replace-with-a-long-random-secret \
  -buckets=vigil-flows \
  -actions=Read,Write,List,Tagging \
  -apply
EOF
```

`-buckets=vigil-flows` keeps this identity unable to touch any other bucket,
and omitting `Admin` from `-actions` keeps it unable to change its own
permissions. SeaweedFS addresses objects path-style and ignores the SigV4
region, so leave `VIGIL_S3_REGION` at its `us-east-1` default. On AWS S3,
create the bucket and an IAM user with programmatic access instead — the
appliance needs `s3:PutObject` and `s3:ListBucket` on the bucket and nothing
else — and set the region to the bucket's real one.

## Deploy on Proxmox

On the Proxmox host, with `local-lvm` as your target storage and a VM id of
your choosing (the recipe uses 9000). The image is a bootable disk, not an
installer — there is no ISO and no install step.

```bash
# 1. Create the VM: 2 vCPU, 2 GB RAM, on your LAN bridge.
qm create 9000 --name vigil-appliance --cores 2 --memory 2048 \
  --net0 virtio,bridge=vmbr0 --ostype l26

# 2. Import the qcow2 as the VM's disk and attach it as SCSI.
qm importdisk 9000 vigil-appliance-0.1.0-alpha.3.qcow2 local-lvm
qm set 9000 --scsihw virtio-scsi-pci --scsi0 local-lvm:vm-9000-disk-0

# 3. Add the cloud-init drive and point it at your user-data snippet.
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --cicustom user=local:snippets/vigil-appliance-user-data.yaml

# 4. Boot from the disk, and start.
qm set 9000 --boot order=scsi0
qm start 9000
```

The Debian cloud image logs to the serial console; if you want to watch a
first boot, add `--serial0 socket --vga serial0` in step 1 and open it with
`qm terminal 9000`. Sizing note: the image is built and smoke-tested at 2
vCPU, 2 GB RAM and a 32 GB disk — the disk only ever holds the spool (capped
at `VIGIL_SPOOL_MAX_MB`, 2 GiB by default), so the built size is comfortable
headroom, not a requirement.

### The user-data file

Save this as `/var/lib/vz/snippets/vigil-appliance-user-data.yaml` on the
Proxmox host (adjust the path for your storage). This file is the appliance's
entire configuration surface: every variable below is read from it, and the
service refuses to start if the values don't validate.

```yaml
#cloud-config
write_files:
  - path: /etc/vigil-appliance/appliance.env
    permissions: '0600'
    owner: root:root
    content: |
      VIGIL_LISTEN_UDP_PORT=2550
      VIGIL_INGEST_TCP_PORT=2551
      VIGIL_INGEST_TOKEN=change-me-to-a-long-random-string
      VIGIL_S3_ENDPOINT=http://192.168.1.5:8333
      VIGIL_S3_REGION=us-east-1
      VIGIL_S3_BUCKET=vigil-flows
      VIGIL_S3_PREFIX=flows
      VIGIL_S3_ACCESS_KEY=my-access-key-id
      VIGIL_S3_SECRET_KEY=replace-with-a-long-random-secret
runcmd:
  - [systemctl, restart, vigil-appliance.service]
```

Substitute your own values: the token must be at least 16 characters (use
`openssl rand -hex 24`), and the endpoint, bucket and keys are the ones from
the previous section. To reconfigure a running appliance, edit the snippet,
delete the cloud-init drive state, and rerun the `--cicustom` line — cloud-init
reapplies user-data on the next boot.

## Configuration reference

Every variable, its default, and what it does. The first nine are all you
need; the last three tune the pipeline.

| Variable                    | Default     | Meaning                                                               |
| --------------------------- | ----------- | --------------------------------------------------------------------- |
| `VIGIL_LISTEN_UDP_PORT`     | `2550`      | NetFlow v5/v9/IPFIX listener; `0` disables it.                        |
| `VIGIL_INGEST_TCP_PORT`     | `2551`      | NDJSON ingest endpoint; `0` disables it.                              |
| `VIGIL_INGEST_TOKEN`        | —           | Bearer token required by `/ingest` (minimum 16 characters).           |
| `VIGIL_S3_ENDPOINT`         | —           | e.g. `http://192.168.1.5:8333`; always addressed path-style.          |
| `VIGIL_S3_REGION`           | `us-east-1` | SigV4 region (SeaweedFS ignores it; AWS needs the bucket's real one). |
| `VIGIL_S3_BUCKET`           | —           | Target bucket, which must already exist.                              |
| `VIGIL_S3_PREFIX`           | `flows`     | Key prefix for every object.                                          |
| `VIGIL_S3_ACCESS_KEY`       | —           | SigV4 access key.                                                     |
| `VIGIL_S3_SECRET_KEY`       | —           | SigV4 secret key.                                                     |
| `VIGIL_UPLOAD_INTERVAL_SEC` | `300`       | Force-close and flush the open segment after this long.               |
| `VIGIL_UPLOAD_MAX_MB`       | `64`        | Force-close the open segment at this size.                            |
| `VIGIL_SPOOL_MAX_MB`        | `2048`      | Local safety net; the oldest closed segments are dropped beyond it.   |

## Verify it works

Give the VM a minute to boot, then, from another host on the LAN:

```bash
# The ingest endpoint is up and answers 401 without a token:
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/x-ndjson' \
  --data '{"action":"added"}' http://192.168.1.50:2551/ingest
# 401

# With the token, a well-formed line is accepted:
curl -s -X POST \
  -H 'Authorization: Bearer change-me-to-a-long-random-string' \
  -H 'Content-Type: application/x-ndjson' \
  --data '{"action":"added","columns":{"remote_address":"192.168.1.20","remote_port":"443","protocol":"6"}}' \
  http://192.168.1.50:2551/ingest
# {"accepted":1,"invalid":0}
```

On the appliance console (`qm terminal`), `journalctl -u vigil-appliance`
should show `vigil-appliance up: netflow=:2550 ingest=:2551`, and the first
upload lands within `VIGIL_UPLOAD_INTERVAL_SEC` (5 minutes by default; the
verification POST above flushes at the next interval unless more traffic
fills the 64 MB segment first). In the bucket you'll find keys like
`flows/osquery/2026/10/10/14/seg-1760107200000-000000.ndjson.gz` —
`<prefix>/<source>/` plus UTC hour directories, gzipped NDJSON you can read
with `zcat` or query with DuckDB directly.

## Point exporters at it

**NetFlow exporters** — configure your firewall, router or `softflowd` host to
export NetFlow v5, v9 or IPFIX to the appliance's IP address on UDP 2550. The
listener detects the version from each datagram's header; malformed datagrams
are counted, logged (rate-limited) and dropped, never fatal.

**Vigil endpoints** — each machine running Vigil already writes osquery
results to `/var/log/osquery/osqueryd.results.log` and nothing else needs to
change on it. The recipe below is stock systemd plus curl: a script that
sends log lines it has not sent yet, run every minute by a timer. On any
failure it retries with backoff and leaves its offset untouched, so records
are retried — never lost and never sent twice once accepted.

As root on the endpoint:

```bash
mkdir -p /usr/local/lib/vigil-forwarder /var/lib/vigil-forwarder /etc/vigil-forwarder
```

Save the script as `/usr/local/lib/vigil-forwarder/vigil-forward-osquery`:

```sh
#!/bin/sh
# Forward new osquery results-log lines to a Vigil appliance. Run from
# vigil-forwarder.timer; a byte offset makes each run send only what it has
# not sent, and the offset advances only after the appliance answers 202.
set -eu

APPLIANCE=http://192.168.1.50:2551/ingest   # the appliance's address
TOKEN_FILE=/etc/vigil-forwarder/token
LOG=/var/log/osquery/osqueryd.results.log
OFFSET_FILE=/var/lib/vigil-forwarder/osquery.offset

token=$(cat "$TOKEN_FILE")
[ -n "$token" ] || { echo "vigil-forwarder: empty token in $TOKEN_FILE" >&2; exit 1; }

mkdir -p "$(dirname "$OFFSET_FILE")"
touch "$LOG"
size=$(wc -c < "$LOG")
last=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
# The log was rotated or truncated: start over from the beginning.
[ "$size" -ge "$last" ] || last=0
[ "$size" -gt "$last" ] || exit 0

batch=$(mktemp)
trap 'rm -f "$batch"' EXIT
tail -c +"$((last + 1))" "$LOG" > "$batch"

# Retry with backoff; giving up leaves the offset untouched, so the next
# timer run resends the same lines and nothing is lost.
attempt=1
while ! curl -fsS --max-time 30 -X POST \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/x-ndjson' \
    --data-binary @"$batch" "$APPLIANCE" >/dev/null; do
  [ "$attempt" -ge 5 ] && { echo "vigil-forwarder: appliance unreachable, will retry next run" >&2; exit 1; }
  sleep $((attempt * attempt * 5))
  attempt=$((attempt + 1))
done

echo "$size" > "$OFFSET_FILE"
```

Store the token — the same string as the appliance's `VIGIL_INGEST_TOKEN` —
in `/etc/vigil-forwarder/token`, owned by root and mode 0600, since the log
file itself is root-readable only and the unit runs as root:

```bash
printf 'change-me-to-a-long-random-string' > /etc/vigil-forwarder/token
chmod 0600 /etc/vigil-forwarder/token
```

Save the units as `/etc/systemd/system/vigil-forwarder.service` and
`/etc/systemd/system/vigil-forwarder.timer`:

```ini
[Unit]
Description=Forward osquery results to the Vigil appliance
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/lib/vigil-forwarder/vigil-forward-osquery
```

```ini
[Unit]
Description=Run the Vigil forwarder every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
```

```bash
chmod +x /usr/local/lib/vigil-forwarder/vigil-forward-osquery
systemctl daemon-reload
systemctl enable --now vigil-forwarder.timer
```

Notes on the recipe. It sends batches of complete lines as one NDJSON POST
and expects 202; `curl --fail` treats 401 and 413 as failures, so a wrong
token or an oversized line shows up as retries plus a stderr note rather than
silent loss. osquery logs each row as one line with a single write, and the
appliance treats a malformed line as counted-and-dropped rather than fatal,
so a line caught mid-write in a torn-read race is one lost record, logged
rate-limited on the appliance — rare, and self-evident in the counters.

## Failure semantics, in one place

Where things go, and what happens when they go wrong:

- **At-least-once upload.** A closed segment is deleted from the spool only
  after its PUT returned a 2xx. Retriable failures (5xx, 429, timeouts) retry
  with exponential backoff and full jitter (1 s base, 60 s cap); other 4xx
  responses — a wrong key, a bad credential — park the segment on disk for
  the next boot's rescan instead of retrying forever. Re-uploading a segment
  overwrites the same deterministic key, so retries can't duplicate objects.
- **Boot recovery.** On every start the uploader rescans the spool and
  drains the backlog oldest-first, and any segment left open by a crash is
  gzipped into that backlog first. Nothing is lost across restarts that fits
  on the disk.
- **Bounded spool.** When the spool exceeds `VIGIL_SPOOL_MAX_MB`, the oldest
  closed segments are deleted, one error is logged (rate-limited), and
  ingestion continues — the appliance degrades to bounded loss rather than
  filling the disk or crashing.
- **The open segment is never uploaded.** Only closed, gzipped segments
  enter the upload queue; an open segment is flushed at the latest by
  `VIGIL_UPLOAD_INTERVAL_SEC`.
- **UDP loss is inherent.** NetFlow datagrams are unacknowledged; a burst at
  link saturation can drop packets at the socket buffer. The receive buffer
  is sized generously and drop counters are logged — this is a property of
  the protocol, not a defect.

## Related

- [The appliance README](../apps/appliance/README.md) — source layout,
  responsibility boundaries and where each pin lives.
- The specification this shipped from lives in the Obvious project; the
  env contract's source of truth in the repo is
  `apps/appliance/collector/src/config.ts`.
