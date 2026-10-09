import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { thirdPartyLicenses } from './scripts/third-party-licenses.mjs';
import { resolveUpdateRepo } from './src/main/update-repo.js';

// Everything the app imports is a devDependency and gets bundled, so the packaged
// app ships only `out/` and no node_modules. A package that must stay external
// (for example one that spawns its own binary) goes in `dependencies` and needs
// externalizeDepsPlugin here. thirdPartyLicenses writes the license texts of
// what gets bundled to build/licenses, which the packages ship.

/** The commit being built, shown in Settings › About so a report names the exact build. */
function buildCommit(): string {
  const sha = process.env['GITHUB_SHA'];
  if (sha) return sha.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The repo this build checks for updates (update-repo.ts decides): an explicit
 * VIGIL_UPDATE_REPO wins, an upstream checkout checks upstream, a fork checkout
 * ships with update checks off.
 */
function buildUpdateRepo(): string | null {
  let origin: string | undefined;
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    // No git checkout (a source tarball): resolveUpdateRepo defaults to upstream.
  }
  return resolveUpdateRepo(process.env['VIGIL_UPDATE_REPO'], origin) ?? null;
}

export default defineConfig({
  main: {
    define: {
      __VIGIL_COMMIT__: JSON.stringify(buildCommit()),
      __VIGIL_UPDATE_REPO__: JSON.stringify(buildUpdateRepo()),
    },
    plugins: [thirdPartyLicenses('main')],
  },
  preload: {
    plugins: [thirdPartyLicenses('preload')],
    build: {
      rollupOptions: {
        // electron-vite 5 does not externalize electron for a CommonJS preload under
        // vite 8, which bundles the npm stub and leaves window.vigil undefined.
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), thirdPartyLicenses('renderer')],
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
  },
});
