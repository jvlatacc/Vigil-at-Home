import { pathToFileURL } from 'node:url';
import { loadApplianceConfig, type ApplianceConfig } from './config';
import { IngestServer } from './ingest';
import { NetFlowListener } from './listener';
import type { IngestRecord } from './record';
import { SpoolWriter } from './spool';
import { SpoolUploader } from './uploader';

/** Production spool root — the StateDirectory systemd provisions. Tests
 * inject their own via ServiceOptions.spoolRoot; there is deliberately no
 * VIGIL_ env var for this (the public config contract stays as specced). */
export const SPOOL_ROOT = '/var/lib/vigil-appliance/spool';

/** How often the rotator's interval/hour checks run. */
const TICK_MS = 1000;

export interface ServiceOptions {
  /** Config source; defaults to process.env (the cloud-init env file). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Spool directory override — tests only; production uses SPOOL_ROOT. */
  spoolRoot?: string;
  log?: (message: string) => void;
}

export interface ServiceHandle {
  /** Graceful shutdown: stop listeners, flush open segments, stop uploading.
   * Segments that never reached a 2xx stay on disk for the next boot. */
  stop(): Promise<void>;
  /** The bound ingest port, null when disabled (VIGIL_INGEST_TCP_PORT=0). */
  ingestPort(): number | null;
  /** The bound NetFlow port, undefined when disabled. */
  netflowPort(): number | undefined;
}

function envLogger(level: 'ERROR' | 'WARN', message: string): void {
  // One structured line per event; journald is the operator's view.
  const text = `[${level}] ${message}`;
  if (level === 'ERROR') console.error(text);
  else console.warn(text);
}

/**
 * The appliance service: both ingestion paths (NetFlow UDP listener,
 * authenticated NDJSON ingest) feed one spool → gzip → S3 pipeline.
 * This is what the Packer image ships as the systemd ExecStart. Boot order
 * matters: spool recovery must run before the upload backlog is scanned, so
 * crash-orphaned raw segments are gzipped into the backlog, not re-uploaded
 * as plaintext.
 */
export async function startService(options: ServiceOptions = {}): Promise<ServiceHandle> {
  const config = loadApplianceConfig(options.env);
  const log = options.log ?? ((message: string) => console.log(message));
  const spoolRoot = options.spoolRoot ?? SPOOL_ROOT;

  // 1. The uploader owns the backlog; closed segments are enqueued into it.
  const uploader = new SpoolUploader({ config: uploaderConfigOf(config), log: envLogger });

  // 2. Spool recovery (creates the layout, gzips crash leftovers).
  const writer = new SpoolWriter({
    rootDir: spoolRoot,
    maxSegmentBytes: config.uploadMaxMb * 1024 * 1024,
    maxIntervalMs: config.uploadIntervalSec * 1000,
    maxSpoolBytes: config.spoolMaxMb * 1024 * 1024,
    onSegmentClosed: (segment) => uploader.enqueue(segment),
    log: envLogger,
  });
  await writer.init();

  // 3. Boot-time rescan: everything already on disk becomes upload backlog.
  const backlog = await uploader.scanAndEnqueue(spoolRoot);

  // 4. The rotator's idle-time driver (hour boundaries, upload interval).
  const ticker = setInterval(() => {
    void writer.tick(Date.now()).catch((err: unknown) => {
      envLogger('ERROR', `spool tick failed: ${describe(err)}`);
    });
  }, TICK_MS);
  ticker.unref();

  // 5. Both ingestion paths append into the same spool. Port 0 disables a
  // path — a service-level decision, per the spec's config table.
  const sink = (records: IngestRecord[]): void => {
    for (const record of records) writer.append(record);
  };
  let listener: NetFlowListener | undefined;
  if (config.listenUdpPort !== 0) {
    listener = new NetFlowListener({ port: config.listenUdpPort, sink, log });
    await listener.start();
  }
  let ingest: IngestServer | undefined;
  if (config.ingestTcpPort !== 0) {
    ingest = new IngestServer({
      port: config.ingestTcpPort,
      token: config.ingestToken,
      onRecord: (record) => writer.append(record),
    });
    await ingest.listen();
  }

  log(
    `vigil-appliance up: netflow=${listener ? `:${listener.boundPort()}` : 'disabled'} ` +
      `ingest=${ingest ? `:${ingest.boundPort()}` : 'disabled'} spool=${spoolRoot} ` +
      `backlog=${backlog} segments`,
  );

  // Idempotent: systemd may send a second SIGTERM while the first is
  // draining; a repeated stop must be a no-op, not a crash.
  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(ticker);
      // Stop the listeners first so no new records arrive mid-flush.
      listener?.stop();
      await ingest?.stop();
      await writer.close();
      // Parked segments (never-2xx) stay on disk; the next boot rescans.
      await uploader.stop();
    },
    ingestPort(): number | null {
      return ingest ? ingest.boundPort() : null;
    },
    netflowPort(): number | undefined {
      return listener?.boundPort();
    },
  };
}

function uploaderConfigOf(config: ApplianceConfig) {
  return {
    s3Endpoint: config.s3Endpoint,
    s3Region: config.s3Region,
    s3Bucket: config.s3Bucket,
    s3Prefix: config.s3Prefix,
    s3AccessKey: config.s3AccessKey,
    s3SecretKey: config.s3SecretKey,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * True when this module is the executed entry (node or an esbuild bundle) —
 * extracted so the entry guard itself stays testable.
 */
export function isMainModule(entryPath: string | undefined, moduleUrl: string): boolean {
  return entryPath !== undefined && moduleUrl === pathToFileURL(entryPath).href;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  void startService()
    .then((handle) => {
      const shutdown = (signal: string): void => {
        console.log(`received ${signal}, shutting down`);
        void handle
          .stop()
          .then(() => process.exit(0))
          .catch((err: unknown) => {
            console.error(`shutdown failed: ${describe(err)}`);
            process.exit(1);
          });
      };
      process.once('SIGTERM', () => shutdown('SIGTERM'));
      process.once('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((err: unknown) => {
      // Refuses to start on invalid config — per the spec, the service must
      // not run with a configuration it could not validate.
      console.error(`vigil-appliance failed to start: ${describe(err)}`);
      process.exit(1);
    });
}
