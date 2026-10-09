// Builds the relay into a single runnable file for deployment:
//   build/relay.mjs  the CLI and server, bundled (esbuild, node22)
//
// Usage: node scripts/build.mjs

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { BUNDLE_OPTIONS } from '../../desktop/scripts/bundle-options.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const outfile = join(pkg, 'build', 'relay.mjs');

mkdirSync(dirname(outfile), { recursive: true });
await build({
  ...BUNDLE_OPTIONS,
  entryPoints: [join(pkg, 'src', 'cli.ts')],
  outfile,
});
process.stdout.write(`built ${outfile}\n`);
