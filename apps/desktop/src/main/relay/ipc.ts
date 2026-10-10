import type { Handlers } from '../ipc.js';
import type { RelayService } from './service.js';

type RelayCall = 'getRelay' | 'setRelayConfig' | 'setRelayToken' | 'clearRelayToken';

/** The four relay calls: the settings card's read and writes. */
export function relayHandlers(relay: RelayService): Pick<Handlers, RelayCall> {
  return {
    getRelay: () => relay.view(),
    setRelayConfig: (patch) => relay.setConfig(patch),
    setRelayToken: (token) => relay.setToken(token),
    clearRelayToken: () => relay.clearToken(),
  };
}
