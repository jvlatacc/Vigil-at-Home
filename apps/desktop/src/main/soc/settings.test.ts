import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SocExporter } from '@vigil/soc-export';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '../testing.js';
import { SocSettingsStore } from './settings.js';

/**
 * A cipher with no Keychain behind it: a reversible stand-in that refuses to
 * decrypt what it did not encrypt — the shape safeStorage has.
 */
const fakeCipher = {
  available: () => true,
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: (data: Buffer) => {
    const text = data.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not our ciphertext');
    return text.slice(4);
  },
};

function makeStore(cipher = fakeCipher): { soc: SocSettingsStore; keyPath: string } {
  const keyPath = join(mkdtempSync(join(tmpdir(), 'vigil-soc-test-')), 'soc-keys.json');
  return { soc: new SocSettingsStore({ store: memoryStore(), keyPath, cipher }), keyPath };
}

/** The rule lookup the exporter needs; MITRE tags live on Rule.tags. */
const ruleOf = () => ({ tags: ['T1059.001'] });

describe('SocSettingsStore', () => {
  it('reads as off on a fresh install, with no transport to reach the network', () => {
    const { soc } = makeStore();
    expect(soc.settings().enabled).toBe(false);
    const view = soc.view();
    expect(view.enabled).toBe(false);
    expect(view.keySaved).toBe(false);
    expect(view.canSave).toBe(true);
    // The default-off guarantee, end to end: an exporter built from these
    // settings has no queues and no client, so an alert has nowhere to go.
    const exporter = SocExporter.create(soc.settings(), { ruleOf });
    expect(exporter.enabled).toBe(false);
    exporter.exportAlert({
      id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      createdAt: 0,
      updatedAt: 0,
      ruleId: 'test.rule',
      ruleVersion: 1,
      title: 't',
      summary: 's',
      severity: 'high',
      fidelity: 'high',
      notify: 'silent',
      status: 'open',
      containment: 'none',
      eventIds: [],
      actionIds: [],
    });
    expect(exporter.pending).toBe(0);
    expect(exporter.enabled).toBe(false);
  });

  it('refuses to enable without an address and a key, and says what is missing', () => {
    const { soc } = makeStore();
    const view = soc.set({ enabled: true });
    expect(view.enabled).toBe(false);
    expect(view.errors).toEqual([
      'A Vigil SOC address is required to enable export.',
      'An API key is required to enable export.',
    ]);
    expect(soc.settings().enabled).toBe(false);
  });

  it('refuses an http endpoint that is not localhost', () => {
    const { soc } = makeStore();
    const view = soc.set({ enabled: true, socBaseUrl: 'http://soc.example.com', socApiKey: 'k' });
    expect(view.enabled).toBe(false);
    expect(view.errors).toEqual([
      'The Vigil SOC address must use https, or http only for localhost.',
    ]);
    // The address is kept so the user can fix it, but the switch stays off.
    expect(view.socBaseUrl).toBe('http://soc.example.com');
    expect(soc.settings().enabled).toBe(false);
  });

  it('keeps the plaintext key out of the key file, and the view shows only last4', () => {
    const { soc, keyPath } = makeStore();
    const view = soc.set({ socApiKey: 'vsk-secret-1234567890' });
    expect(view.keySaved).toBe(true);
    expect(view.keyLast4).toBe('7890');
    const raw = readFileSync(keyPath, 'utf8');
    expect(raw).not.toContain('vsk-secret');
    expect(raw).toContain('"enc"');
    // And it decrypts back, main-process side.
    expect(soc.settings().socApiKey).toBe('vsk-secret-1234567890');
    expect(soc.settings().enabled).toBe(false);
  });

  it('turns on with an address and a key, and the exporter really runs', () => {
    const { soc } = makeStore();
    const view = soc.set({ enabled: true, socBaseUrl: 'https://soc.example.com', socApiKey: 'k' });
    expect(view.enabled).toBe(true);
    expect(view.errors).toEqual([]);
    const settings = soc.settings();
    expect(settings.enabled).toBe(true);
    expect(settings.socApiKey).toBe('k');
    expect(SocExporter.create(settings, { ruleOf }).enabled).toBe(true);
  });

  it('keeps settings when read again through a new store over the same state', () => {
    const store = memoryStore();
    const keyPath = join(mkdtempSync(join(tmpdir(), 'vigil-soc-test-')), 'soc-keys.json');
    new SocSettingsStore({ store, keyPath, cipher: fakeCipher }).set({
      enabled: true,
      socBaseUrl: 'https://soc.example.com',
      socApiKey: 'k',
    });
    // A restart builds a fresh store over the same saved state.
    const again = new SocSettingsStore({ store, keyPath, cipher: fakeCipher });
    expect(again.settings().enabled).toBe(true);
    expect(again.settings().socApiKey).toBe('k');
  });

  it('turns export off when the key is cleared, and forgets the key', () => {
    const { soc } = makeStore();
    soc.set({ enabled: true, socBaseUrl: 'https://soc.example.com', socApiKey: 'k' });
    const view = soc.clearKey();
    expect(view.enabled).toBe(false);
    expect(view.keySaved).toBe(false);
    expect(view.keyLast4).toBeUndefined();
    expect(soc.settings().enabled).toBe(false);
  });

  it('treats an undecryptable key as no key, so export stays off', () => {
    const { soc, keyPath } = makeStore();
    soc.set({ enabled: true, socBaseUrl: 'https://soc.example.com', socApiKey: 'k' });
    // A key written by another build (or a mangled file) must not crash the
    // app or leak an export: it reads as absent, and the switch goes off.
    writeRawKeyFile(keyPath, 'not-our-ciphertext');
    expect(soc.settings().enabled).toBe(false);
    expect(soc.view().keySaved).toBe(false);
  });

  it('cannot save a key when the Keychain is unavailable, and refuses the switch', () => {
    const lockedCipher = { ...fakeCipher, available: () => false };
    const { soc } = makeStore(lockedCipher);
    expect(soc.view().canSave).toBe(false);
    expect(() =>
      soc.set({ enabled: true, socBaseUrl: 'https://soc.example.com', socApiKey: 'k' }),
    ).toThrow('Keychain');
    expect(soc.settings().enabled).toBe(false);
  });
});

/** Writes a key file entry the test cipher cannot decrypt. */
function writeRawKeyFile(path: string, plaintext: string): void {
  mkdirSync(path.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      soc: { enc: Buffer.from(plaintext, 'utf8').toString('base64'), last4: 'text' },
    }),
  );
}
