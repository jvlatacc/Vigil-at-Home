import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { handleIngest, INGEST_PATH, sendJson } from './ingest.js';
import { RelayStore } from './store.js';
import type { RelayConfig } from './config.js';

export interface RelayServer {
  port: number;
  store: RelayStore;
  close(): Promise<void>;
}

/**
 * The relay's one listener: unauthenticated /healthz (data-free, for load
 * balancers) and the ingest route. The MCP face for the SOC mounts on this
 * listener too.
 */
export function startRelay(config: RelayConfig, store?: RelayStore): Promise<RelayServer> {
  const ownedStore = store ?? new RelayStore(config.dataDir);

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url === INGEST_PATH) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' });
        return;
      }
      void handleIngest(req, res, { store: ownedStore, maxBodyBytes: config.maxBodyBytes });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  };

  let server: Server;
  if (config.tlsCert !== undefined && config.tlsKey !== undefined) {
    const secure = createSecureServer(
      { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey) },
      handler,
    );
    secure.headersTimeout = 5_000;
    secure.requestTimeout = 10_000;
    server = secure;
  } else {
    server = createServer(handler);
    server.headersTimeout = 5_000;
    server.requestTimeout = 10_000;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : config.port;
      resolve({
        port,
        store: ownedStore,
        close: () =>
          new Promise((done) => {
            // Drop idle keep-alive sockets (undici keeps them open) so a
            // graceful stop ends without waiting on clients.
            server.closeIdleConnections();
            server.close(() => {
              ownedStore.close();
              done();
            });
          }),
      });
    });
  });
}
