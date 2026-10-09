import { describe, expect, it } from 'vitest';
import { SocSettings, enablementErrors } from '../config.js';

describe('SocSettings', () => {
  it('defaults to export off, nothing configured, and the spec batch shape', () => {
    const settings = SocSettings.parse({});
    expect(settings.enabled).toBe(false);
    expect(settings.socBaseUrl).toBe('');
    expect(settings.socApiKey).toBe('');
    expect(settings.batch).toEqual({ maxItems: 50, flushAfterMs: 5_000, maxQueueItems: 500 });
    expect(settings.backoff).toEqual({ initialMs: 1_000, maxMs: 60_000, multiplier: 2 });
  });
});

describe('enablementErrors', () => {
  it('needs nothing from disabled settings, however empty', () => {
    expect(enablementErrors(SocSettings.parse({}))).toEqual([]);
  });

  it('requires both an address and a key to enable', () => {
    const errors = enablementErrors(SocSettings.parse({ enabled: true }));
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).toMatch(/address/);
    expect(errors.join(' ')).toMatch(/API key/);
  });

  it('refuses a remote plaintext endpoint', () => {
    const errors = enablementErrors(
      SocSettings.parse({ enabled: true, socBaseUrl: 'http://soc.example.com', socApiKey: 'k' }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/https/);
  });

  it('accepts https, or http on this machine, with a key', () => {
    expect(
      enablementErrors(
        SocSettings.parse({ enabled: true, socBaseUrl: 'https://soc.example.com', socApiKey: 'k' }),
      ),
    ).toEqual([]);
    // The Docker quick start the demo targets.
    expect(
      enablementErrors(
        SocSettings.parse({ enabled: true, socBaseUrl: 'http://127.0.0.1:6987', socApiKey: 'k' }),
      ),
    ).toEqual([]);
  });
});
