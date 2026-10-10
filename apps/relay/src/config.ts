/**
 * The relay's configuration, from environment variables (12-factor: the
 * deployable unit is a container; the operator's knobs are env vars).
 */

export interface RelayConfig {
  dataDir: string;
  host: string;
  port: number;
  /** Evict oldest telemetry when storage exceeds this. */
  maxDiskBytes: number;
  /** Stream records older than this many days are evicted. */
  retentionDays: number;
  /** Largest accepted (compressed) ingest body. */
  maxBodyBytes: number;
  /** Ingest rate limit, mirroring the agent socket's limits. */
  ratePerSec: number;
  burst: number;
  /** When both are set, the server speaks TLS itself; otherwise plain HTTP behind the operator's proxy. */
  tlsCert?: string;
  tlsKey?: string;
}

export const RELAY_DEFAULTS = {
  port: 8443,
  host: '0.0.0.0',
  maxDiskMb: 10 * 1024,
  retentionDays: 30,
  maxBodyMb: 16,
  /** Per-device ingest limits, the agent socket's numbers (endpoint.ts). */
  ratePerSec: 30,
  burst: 60,
} as const;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function mbFromEnv(env: NodeJS.ProcessEnv, name: string, fallbackMb: number): number {
  const mb = intFromEnv(env, name, fallbackMb);
  if (mb <= 0) throw new Error(`${name} must be positive`);
  return mb * 1024 * 1024;
}

export function resolveConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const tlsCert = env.RELAY_TLS_CERT;
  const tlsKey = env.RELAY_TLS_KEY;
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw new Error(
      'Set RELAY_TLS_CERT and RELAY_TLS_KEY together, or neither (plain HTTP behind your own TLS-terminating proxy).',
    );
  }
  const port = intFromEnv(env, 'RELAY_PORT', RELAY_DEFAULTS.port);
  if (port < 1 || port > 65535) throw new Error('RELAY_PORT must be between 1 and 65535');
  const config: RelayConfig = {
    dataDir: env.RELAY_DATA_DIR ?? 'data',
    host: env.RELAY_HOST ?? RELAY_DEFAULTS.host,
    port,
    maxDiskBytes: mbFromEnv(env, 'RELAY_MAX_DISK_MB', RELAY_DEFAULTS.maxDiskMb),
    retentionDays: intFromEnv(env, 'RELAY_RETENTION_DAYS', RELAY_DEFAULTS.retentionDays),
    maxBodyBytes: mbFromEnv(env, 'RELAY_MAX_BODY_MB', RELAY_DEFAULTS.maxBodyMb),
    ratePerSec: RELAY_DEFAULTS.ratePerSec,
    burst: RELAY_DEFAULTS.burst,
  };
  if (tlsCert !== undefined && tlsKey !== undefined) {
    config.tlsCert = tlsCert;
    config.tlsKey = tlsKey;
  }
  return config;
}
