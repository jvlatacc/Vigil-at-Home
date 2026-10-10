# @vigil/appliance

The NetFlow-to-S3 appliance: one Node service that turns NetFlow datagrams and
Vigil endpoint NDJSON into gzipped NDJSON objects in any S3-compatible bucket,
shipped as a Debian VM image built with Packer.

```
NetFlow exporters (firewall, router, softflowd)
  │
  │  UDP :2550 (v5, v9, IPFIX)
  ▼
listener.ts ──► decode/ ──► normalize.ts ──────────────┐
                                                       │
Vigil endpoints (osqueryd.results.log, no code change) │
  │                                                    ├─► record.ts (vigil.flow.v1)
  │  POST /ingest :2551 (bearer token, NDJSON)         │       │ every record
  ▼                                                    │       ▼
ingest.ts ──► osqueryLineToRecord ─────────────────────┘   spool.ts
                                                  append JSONL, rotate on the
                                                        │ hour / 64 MB / 5 min
                                                        ▼
                                              closed segments, gzipped
                                                        │
                                                        ▼
                                                   uploader.ts
                                          SigV4 PUT, path-style, retries
                                                        │
                                                        ▼
                                          <endpoint>/<bucket>/<prefix>/
                                            <source>/YYYY/MM/DD/HH/
                                              seg-<startMs>-<seq>.ndjson.gz
```

The image is for operators; the deployment guide —
[docs/appliance.md](../../docs/appliance.md) — is how you get from the qcow2 to
a running appliance. This README is about what the code is.

## Layout

```
apps/appliance/
├── collector/src/     the service, TypeScript, bundled by esbuild
│   ├── config.ts      the VIGIL_* env contract, zod-validated
│   ├── record.ts      vigil.flow.v1 — the one record shape on disk
│   ├── listener.ts    UDP :2550 — NetFlow v5/v9/IPFIX datagrams
│   ├── decode/        per-version parsers and template management
│   ├── ingest.ts      TCP :2551 — POST /ingest, bearer token, NDJSON
│   ├── spool.ts       JSONL segments, rotate, gzip, drop-oldest cap
│   ├── uploader.ts    aws4fetch SigV4 PUT, backoff, boot rescan
│   └── service.ts     wires the above; the systemd ExecStart
├── packer/            the image: appliance.pkr.hcl + provision/*.sh
└── scripts/build.sh   the one build entry; emits the qcow2 + SHA256SUMS
```

Colocated `*.test.ts` files run under the root `pnpm check`; integration
tests (`*.integration.test.ts`) self-skip unless enabled, following the repo's
existing practice.

## Responsibility boundaries

- **The collector forwards, nothing more.** It never inspects, alerts,
  queries or retires anything: no detection engine, no UI, no retention
  policy. What lands in the bucket is your data; expiring it is your
  bucket's lifecycle rules, not this service.
- **The service reads its config, never writes it.**
  `/etc/vigil-appliance/appliance.env` is owned by cloud-init
  (`write_files` in your user-data); an invalid value stops the start with
  the offending `VIGIL_*` variable named, and nothing in the image edits the
  file afterward.
- **The open segment is never uploaded.** Only closed, gzipped segments
  enter the upload queue, and a spool file is unlinked only after a 2xx —
  the failure-mode ledger lives in
  [docs/appliance.md](../../docs/appliance.md#failure-semantics-in-one-place).
- **No build credential survives the build.** `packer/` generates a throwaway
  SSH key per build to provision the boot, and `provision/harden.sh` deletes
  the builder user, locks sshd to key-only and resets the machine identity —
  the artifact is a generic template that cloud-init re-provisions at your
  deployment's first boot.
- **The image is the artifact; the bucket is the API.** There is no container,
  no registry and no Vigil-side change: endpoints forward with a stock
  systemd timer plus curl, per the deployment guide's recipe.

## Pins and provenance

Everything runtime-shaped is checksum-pinned, following
`apps/desktop/scripts/build-helper.mjs`:

| What                              | Where pinned                         | Value                              |
| --------------------------------- | ------------------------------------ | ---------------------------------- |
| Debian 12 genericcloud base image | `packer/appliance.pkr.hcl`           | SHA-512 of the pinned qcow2        |
| Node.js runtime                   | `packer/provision/node.sh`           | v22.22.2, SHA-256-verified tarball |
| Collector bundle dependencies     | `packer/provision/package-lock.json` | npm ci integrity hashes            |

## Building the image

`scripts/build.sh` is the only entry point: it checks for `packer`,
`qemu-system-x86_64`, `ssh-keygen`, `node` and `curl`, generates a fresh
builder keypair, autodetects `/dev/kvm` (falling back to TCG with a warning),
runs `packer build`, and emits `vigil-appliance-<version>.qcow2` plus a
`SHA256SUMS` in `packer/output/`. PR CI runs `packer fmt -check` and `packer
validate` only; the full build runs at release.
