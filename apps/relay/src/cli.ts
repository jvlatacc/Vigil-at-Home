#!/usr/bin/env node
// relay serve
//     Run the relay: unauthenticated /healthz and the authenticated ingest
//     route on one listener. TLS when RELAY_TLS_CERT and RELAY_TLS_KEY are
//     set; otherwise plain HTTP behind the operator's TLS-terminating proxy.
// relay provision --device <name>
//     Enroll a laptop: prints its device token once, stores only the hash.
// relay provision --soc <name>
//     Create a SOC token for a Vigil SOC MCP client. Printed once, hashed.
// relay revoke --device <name>
//     Stop accepting pushes from a laptop (its stored telemetry remains).
// relay revoke --soc <name>
//     Stop a SOC client from reading. Run again with the same name to
//     re-issue after revocation.
//
// Provisioning secrets are printed exactly once and never logged by the
// server; the store keeps SHA-256 hashes only. Configuration comes from the
// environment (RELAY_DATA_DIR, RELAY_PORT, ...): see README.md.

import { resolveConfig, RelayStore, startRelay } from './index.js';

const USAGE =
  'usage: relay serve\n' +
  '       relay provision --device <name>\n' +
  '       relay provision --soc <name>\n' +
  '       relay revoke --device <name>\n' +
  '       relay revoke --soc <name>\n';

export interface CliIO {
  /** Normal command output. */
  write: (text: string) => void;
  /** Warnings that are not command output (never a secret). */
  writeErr: (text: string) => void;
  now: () => number;
}

/** The command word and, for provision/revoke, exactly one of --device/--soc. */
export function parseCli(
  argv: string[],
):
  | { command: 'serve' }
  | { command: 'provision' | 'revoke'; kind: 'device' | 'soc'; name: string }
  | { usage: string } {
  const [command, ...rest] = argv;
  if (command === 'serve' && rest.length === 0) return { command: 'serve' };
  if (command === 'provision' || command === 'revoke') {
    const device = rest.indexOf('--device') >= 0 ? rest[rest.indexOf('--device') + 1] : undefined;
    const soc = rest.indexOf('--soc') >= 0 ? rest[rest.indexOf('--soc') + 1] : undefined;
    if ((device === undefined) === (soc === undefined)) {
      return { usage: `${command} takes exactly one of --device <name> or --soc <name>` };
    }
    return device !== undefined
      ? { command, kind: 'device', name: device }
      : { command, kind: 'soc', name: soc as string };
  }
  return { usage: USAGE };
}

/** Provision or revoke against the store; serve is handled by the process shell. */
export function runAdmin(argv: string[], store: RelayStore, io: CliIO): number {
  const parsed = parseCli(argv);
  if ('usage' in parsed) {
    io.writeErr(`${parsed.usage}\n${USAGE}`);
    return 2;
  }
  switch (parsed.command) {
    case 'serve':
      io.writeErr(USAGE);
      return 2;
    case 'provision': {
      if (parsed.kind === 'device') {
        const { deviceId, token } = store.provisionDevice(parsed.name, io.now());
        io.writeErr(`device ${parsed.name} enrolled as ${deviceId}. This token is shown once:\n`);
        io.write(`${token}\n`);
      } else {
        const { token } = store.provisionSoc(parsed.name, io.now());
        io.writeErr(`SOC token for ${parsed.name}. This token is shown once:\n`);
        io.write(`${token}\n`);
      }
      return 0;
    }
    case 'revoke': {
      const { revokedTokens } =
        parsed.kind === 'device'
          ? store.revokeDevice(parsed.name, io.now())
          : store.revokeSoc(parsed.name, io.now());
      io.write(`revoked ${revokedTokens} token(s) for ${parsed.kind} ${parsed.name}\n`);
      return 0;
    }
  }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const config = resolveConfig(process.env);
  if (command === 'serve') {
    const relay = await startRelay(config);
    const tls = config.tlsCert !== undefined ? 'tls' : 'http';
    process.stdout.write(`relay listening on ${relay.port} (${tls}), data in ${config.dataDir}\n`);
    const stop = (signal: string): void => {
      process.stdout.write(`relay received ${signal}, closing\n`);
      void relay.close().then(
        () => process.exit(0),
        (err: unknown) => {
          process.stderr.write(`relay failed to close cleanly: ${String(err)}\n`);
          process.exit(1);
        },
      );
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
    return;
  }
  if (command === undefined) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  // Provisioning and revocation: open the store, act, close. Never serves.
  const store = new RelayStore(config.dataDir);
  try {
    const io: CliIO = {
      write: (t) => process.stdout.write(t),
      writeErr: (t) => process.stderr.write(t),
      now: Date.now,
    };
    process.exit(runAdmin(process.argv.slice(2), store, io));
  } finally {
    store.close();
  }
}

// Run only when executed directly (the entry is bundled to build/relay.mjs);
// importing this module from tests must not start anything.
if (process.argv[1]?.endsWith('relay.mjs')) {
  void main().catch((err: unknown) => {
    process.stderr.write(`relay: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
