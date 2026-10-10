import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { enablementErrors, SocSettings } from '@vigil/soc-export';
import type { SocSettings as SocSettingsValue } from '@vigil/soc-export';
import { SocSettingsPatch, type SocView } from '../../shared/soc.js';
import type { Store } from '../db/store.js';
import { readPrivate, writePrivate, type Cipher } from '../onboarding/keys.js';

/** Where the non-secret SOC settings live, beside the AI prefs and the like. */
const SETTINGS_KEY = 'soc';

/** The settings-table part: everything but the key, which never goes in the DB. */
const SavedSoc = SocSettings.pick({ enabled: true, socBaseUrl: true }).partial();

/** The key file holds one encrypted entry, exactly like the feed keys. */
const KeyEntry = z.object({ enc: z.string(), last4: z.string().max(4) });
const KeyFile = z.object({ soc: KeyEntry.optional() });
type KeyFile = z.infer<typeof KeyFile>;

export type SocSettingsStoreDeps = {
  store: Pick<Store, 'getSetting' | 'setSetting'>;
  /** Where the safeStorage-encrypted key is kept, e.g. <userData>/soc-keys.json. */
  keyPath: string;
  cipher: Cipher;
};

/**
 * SOC export settings, in two places: the switch and address in the settings
 * table, the bearer key alone in a safeStorage-encrypted file — like the AI
 * and feed keys, so the renderer never sees it, only that it is saved.
 *
 * The local-first rule lives here above all: a fresh install reads as off,
 * and nothing persists a switch-on that cannot run. `settings()` is what the
 * forwarder builds its exporter from; `view()` is what the renderer sees.
 */
export class SocSettingsStore extends EventEmitter<{ changed: [] }> {
  constructor(private readonly o: SocSettingsStoreDeps) {
    super();
  }

  /** The full settings for the exporter, key included. Main process only. */
  settings(): SocSettingsValue {
    const saved = this.readSaved();
    const key = this.savedKey();
    // A key that cannot be decrypted is no key: export stays off.
    return SocSettings.parse({
      enabled: saved.enabled === true && key !== undefined,
      ...(saved.socBaseUrl ? { socBaseUrl: saved.socBaseUrl } : {}),
      ...(key ? { socApiKey: key } : {}),
    });
  }

  /** What Settings shows. Never carries the key itself. */
  view(): SocView {
    const saved = this.readSaved();
    const key = this.savedKey();
    const entry = this.readKeys().soc;
    const settings = SocSettings.parse({
      enabled: saved.enabled === true && key !== undefined,
      ...(saved.socBaseUrl ? { socBaseUrl: saved.socBaseUrl } : {}),
      ...(key ? { socApiKey: key } : {}),
    });
    return {
      enabled: settings.enabled,
      socBaseUrl: settings.socBaseUrl,
      keySaved: key !== undefined,
      ...(entry?.last4 ? { keyLast4: entry.last4 } : {}),
      canSave: this.o.cipher.available(),
      // What stands between the user and switching on — even while off, so
      // the row can show the checklist instead of a bare refusal.
      errors: enablementErrors({ ...settings, enabled: true }),
    };
  }

  /**
   * Apply the renderer's patch. The key saves first; a switch-on is refused
   * (never persisted) unless an address, a key, and a safe endpoint exist —
   * the returned view carries what is missing instead of throwing.
   */
  set(raw: SocSettingsPatch): SocView {
    const patch = SocSettingsPatch.parse(raw);
    const saved = this.readSaved();
    const url = patch.socBaseUrl !== undefined ? patch.socBaseUrl.trim() : saved.socBaseUrl;
    if (patch.socApiKey !== undefined && patch.socApiKey !== '') this.saveKey(patch.socApiKey);
    const wanted = patch.enabled ?? saved.enabled ?? false;
    const key = this.savedKey();
    const candidate = SocSettings.parse({
      enabled: wanted,
      ...(url ? { socBaseUrl: url } : {}),
      ...(key ? { socApiKey: key } : {}),
    });
    const errors = enablementErrors(candidate);
    // Persist the switch only when it can run; with gaps, it stays off and
    // the view explains why. The address is kept either way.
    this.writeSaved({
      enabled: errors.length ? false : wanted,
      ...(url ? { socBaseUrl: url } : {}),
    });
    this.emit('changed');
    return errors.length ? { ...this.view(), errors } : this.view();
  }

  /** Forget the key. Without one export cannot run, so the switch goes off. */
  clearKey(): SocView {
    const file = this.readKeys();
    delete file.soc;
    writePrivate(this.o.keyPath, file);
    this.writeSaved({ enabled: false, socBaseUrl: this.readSaved().socBaseUrl });
    this.emit('changed');
    return this.view();
  }

  private readSaved(): z.infer<typeof SavedSoc> {
    try {
      return SavedSoc.parse(this.o.store.getSetting(SETTINGS_KEY, z.unknown(), {}));
    } catch {
      // A corrupt row keeps export off — the safe direction — and the next
      // save rewrites it whole.
      return {};
    }
  }

  private writeSaved(saved: z.infer<typeof SavedSoc>): void {
    this.o.store.setSetting(SETTINGS_KEY, SavedSoc.parse(saved));
  }

  private readKeys(): KeyFile {
    return readPrivate(this.o.keyPath, KeyFile);
  }

  private saveKey(key: string): void {
    if (!this.o.cipher.available())
      throw new Error('The Keychain isn’t available, so the key can’t be saved safely right now');
    const file = this.readKeys();
    file.soc = { enc: this.o.cipher.encrypt(key).toString('base64'), last4: key.slice(-4) };
    writePrivate(this.o.keyPath, file);
  }

  /** The decrypted key, or nothing: an undecryptable key is treated as absent. */
  private savedKey(): string | undefined {
    const entry = this.readKeys().soc;
    if (!entry) return undefined;
    try {
      return this.o.cipher.decrypt(Buffer.from(entry.enc, 'base64'));
    } catch {
      return undefined;
    }
  }
}
