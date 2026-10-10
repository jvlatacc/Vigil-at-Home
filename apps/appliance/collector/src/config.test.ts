import { describe, expect, it } from 'vitest';
import { ConfigError, loadApplianceConfig } from './config';

const requiredEnv = {
  VIGIL_INGEST_TOKEN: 'a-long-random-token-1234',
  VIGIL_S3_ENDPOINT: 'http://192.168.1.5:8333',
  VIGIL_S3_BUCKET: 'vigil-flows',
  VIGIL_S3_ACCESS_KEY: 'seaweed-key',
  VIGIL_S3_SECRET_KEY: 'seaweed-secret',
};

describe('loadApplianceConfig', () => {
  it('applies the spec defaults when only required vars are set', () => {
    const cfg = loadApplianceConfig(requiredEnv);
    expect(cfg.listenUdpPort).toBe(2550);
    expect(cfg.ingestTcpPort).toBe(2551);
    expect(cfg.s3Region).toBe('us-east-1');
    expect(cfg.s3Prefix).toBe('flows');
    expect(cfg.uploadIntervalSec).toBe(300);
    expect(cfg.uploadMaxMb).toBe(64);
    expect(cfg.spoolMaxMb).toBe(2048);
    expect(cfg.s3Endpoint).toBe('http://192.168.1.5:8333');
  });

  it('coerces numeric strings from the env file', () => {
    const cfg = loadApplianceConfig({
      ...requiredEnv,
      VIGIL_LISTEN_UDP_PORT: '9999',
      VIGIL_SPOOL_MAX_MB: '512',
    });
    expect(cfg.listenUdpPort).toBe(9999);
    expect(cfg.spoolMaxMb).toBe(512);
  });

  it('treats empty-string variables as unset so defaults apply', () => {
    const cfg = loadApplianceConfig({ ...requiredEnv, VIGIL_S3_PREFIX: '' });
    expect(cfg.s3Prefix).toBe('flows');
  });

  it('refuses to start when the ingest token is missing', () => {
    const { VIGIL_INGEST_TOKEN: _token, ...withoutToken } = requiredEnv;
    expect(() => loadApplianceConfig(withoutToken)).toThrow(ConfigError);
  });

  it('refuses a token shorter than 16 characters, naming the env var', () => {
    try {
      loadApplianceConfig({ ...requiredEnv, VIGIL_INGEST_TOKEN: 'short' });
      expect.unreachable('config with a short token must not load');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('VIGIL_INGEST_TOKEN');
    }
  });

  it('accepts a token of exactly 16 characters', () => {
    const cfg = loadApplianceConfig({ ...requiredEnv, VIGIL_INGEST_TOKEN: '0123456789abcdef' });
    expect(cfg.ingestToken).toBe('0123456789abcdef');
  });

  it('refuses an invalid s3 endpoint, naming the env var', () => {
    try {
      loadApplianceConfig({ ...requiredEnv, VIGIL_S3_ENDPOINT: 'not a url' });
      expect.unreachable('config with a bad endpoint must not load');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('VIGIL_S3_ENDPOINT');
      expect((err as Error).message).toContain('refusing to start');
    }
  });

  it('refuses a non-numeric port, naming the env var', () => {
    try {
      loadApplianceConfig({ ...requiredEnv, VIGIL_LISTEN_UDP_PORT: 'abc' });
      expect.unreachable('config with a bad port must not load');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('VIGIL_LISTEN_UDP_PORT');
    }
  });

  it('reports every offending variable at once', () => {
    try {
      loadApplianceConfig({ VIGIL_S3_BUCKET: '' });
      expect.unreachable('config missing everything must not load');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('VIGIL_INGEST_TOKEN');
      expect((err as Error).message).toContain('VIGIL_S3_ENDPOINT');
      expect((err as Error).message).toContain('VIGIL_S3_BUCKET');
    }
  });
});
