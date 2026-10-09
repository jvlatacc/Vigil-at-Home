import { z } from 'zod';

/**
 * The appliance's entire configuration surface, read from
 * /etc/vigil-appliance/appliance.env (written by cloud-init) — see the spec's
 * config table. Cloud-init owns the file; the service only reads it.
 */
export const ApplianceConfig = z.object({
  /** NetFlow v5/v9/IPFIX listener; 0 disables. */
  listenUdpPort: z.coerce.number().int().default(2550),
  /** NDJSON ingest endpoint; 0 disables. */
  ingestTcpPort: z.coerce.number().int().default(2551),
  /** Bearer token required by /ingest (min 16 chars). */
  ingestToken: z.string().min(16),
  /** e.g. http://192.168.1.5:8333 — addressed path-style. */
  s3Endpoint: z.string().url(),
  /** SeaweedFS ignores the region; AWS needs the real one. */
  s3Region: z.string().default('us-east-1'),
  /** Target bucket, must exist. */
  s3Bucket: z.string().min(1),
  /** Key prefix for all objects. */
  s3Prefix: z.string().default('flows'),
  s3AccessKey: z.string().min(1),
  s3SecretKey: z.string().min(1),
  /** Force-close and flush the open segment after this long. */
  uploadIntervalSec: z.coerce.number().int().default(300),
  /** Force-close the open segment at this size. */
  uploadMaxMb: z.coerce.number().int().default(64),
  /** Local safety net; oldest segments are dropped beyond it. */
  spoolMaxMb: z.coerce.number().int().default(2048),
});

export type ApplianceConfig = z.infer<typeof ApplianceConfig>;

/** Env var name for each config field, so errors speak the operator's file. */
const ENV_NAMES: Record<keyof ApplianceConfig, string> = {
  listenUdpPort: 'VIGIL_LISTEN_UDP_PORT',
  ingestTcpPort: 'VIGIL_INGEST_TCP_PORT',
  ingestToken: 'VIGIL_INGEST_TOKEN',
  s3Endpoint: 'VIGIL_S3_ENDPOINT',
  s3Region: 'VIGIL_S3_REGION',
  s3Bucket: 'VIGIL_S3_BUCKET',
  s3Prefix: 'VIGIL_S3_PREFIX',
  s3AccessKey: 'VIGIL_S3_ACCESS_KEY',
  s3SecretKey: 'VIGIL_S3_SECRET_KEY',
  uploadIntervalSec: 'VIGIL_UPLOAD_INTERVAL_SEC',
  uploadMaxMb: 'VIGIL_UPLOAD_MAX_MB',
  spoolMaxMb: 'VIGIL_SPOOL_MAX_MB',
};

/** Raised when the environment does not satisfy the config contract. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parses the VIGIL_* environment into a validated ApplianceConfig and refuses
 * to start on invalid input: every offending variable is named with its env
 * var, not a bare zod dump.
 */
export function loadApplianceConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ApplianceConfig {
  // An env file may export "VAR=" — treat that as unset so defaults apply.
  const present = (field: keyof ApplianceConfig): string | undefined => {
    const value = env[ENV_NAMES[field]];
    return value === undefined || value === '' ? undefined : value;
  };

  const input = {
    listenUdpPort: present('listenUdpPort'),
    ingestTcpPort: present('ingestTcpPort'),
    ingestToken: present('ingestToken'),
    s3Endpoint: present('s3Endpoint'),
    s3Region: present('s3Region'),
    s3Bucket: present('s3Bucket'),
    s3Prefix: present('s3Prefix'),
    s3AccessKey: present('s3AccessKey'),
    s3SecretKey: present('s3SecretKey'),
    uploadIntervalSec: present('uploadIntervalSec'),
    uploadMaxMb: present('uploadMaxMb'),
    spoolMaxMb: present('spoolMaxMb'),
  };

  const parsed = ApplianceConfig.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        // zod issue paths can contain numbers or symbols — coerce explicitly.
        const fieldKey = String(issue.path[0]);
        const envName = ENV_NAMES[fieldKey as keyof ApplianceConfig] ?? fieldKey;
        return `  ${envName}: ${issue.message}`;
      })
      .join('\n');
    throw new ConfigError(`Invalid appliance configuration, refusing to start:\n${details}`);
  }
  return parsed.data;
}
