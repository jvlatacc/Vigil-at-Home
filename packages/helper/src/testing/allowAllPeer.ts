// A PeerGuard that admits everything, for daemon tests whose fake systems
// cannot identify real peers (peer.ts resolves the peer through /proc and
// ss, which no fake reproduces). Production wiring never uses it.
import type { PeerGuard } from '../peer.js';

export function allowAllPeer(): PeerGuard {
  return { check: async () => ({ allow: true }) };
}
