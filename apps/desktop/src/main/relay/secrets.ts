import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { Cipher } from '../onboarding/keys.js';

/**
 * The relay device token: one secret per device, kept like the feed keys and
 * connector bearer tokens — encrypted with the Keychain-backed cipher in a
 * file only the user can read. The renderer sees the last four characters
 * and nothing else, and the token never reaches a log line or a shipped body.
 */

const Entry = z.object({ enc: z.string(), last4: z.string().max(4) });
type Entry = z.infer<typeof Entry>;

/** The token itself, read fresh on every push so a new one takes effect at once. */
export class RelayTokenStore {
  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
  ) {}

  canSave(): boolean {
    return this.cipher.available();
  }

  saved(): boolean {
    return this.read() !== undefined;
  }

  /** Last four characters only, for the settings line. */
  last4(): string | undefined {
    return this.read()?.last4;
  }

  /** The token itself, for the shipper's transport in the main process. */
  get(): string | undefined {
    const e = this.read();
    if (!e) return undefined;
    try {
      return this.cipher.decrypt(Buffer.from(e.enc, 'base64'));
    } catch {
      return undefined;
    }
  }

  set(raw: string): void {
    const token = z.string().min(8).max(200).parse(raw);
    if (!this.cipher.available()) throw new Error("The Keychain isn't available");
    this.write({
      enc: this.cipher.encrypt(token).toString('base64'),
      last4: token.slice(-4),
    });
  }

  clear(): void {
    this.write(undefined);
  }

  private read(): Entry | undefined {
    if (!existsSync(this.path)) return undefined;
    try {
      return Entry.parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch {
      return undefined;
    }
  }

  private write(entry: Entry | undefined): void {
    // Written whole and renamed into place, readable only by the user.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry ?? {}), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
