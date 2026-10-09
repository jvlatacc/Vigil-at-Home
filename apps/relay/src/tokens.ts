import { createHash, randomBytes } from 'node:crypto';

export type TokenKind = 'device' | 'soc';

const PREFIX: Record<TokenKind, string> = { device: 'rvd', soc: 'rvs' };

/**
 * A fresh 256-bit bearer token, prefixed by kind. The admin CLI prints it
 * once; the relay stores only its SHA-256, so it cannot be recovered.
 */
export function newToken(kind: TokenKind): string {
  return `${PREFIX[kind]}1_${randomBytes(32).toString('base64url')}`;
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
