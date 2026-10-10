import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Nested workspace members (e.g. apps/appliance/collector/src) are covered
    // by the double-star, matching pnpm-workspace.yaml's apps/* only one level deep.
    include: ['{apps,packages}/**/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Real-Mac integration tests (root, pf, osquery) run in the macOS workflow's
    // sensors job through each package's test:mac script.
    exclude: ['**/node_modules/**', '**/*.mac.test.ts'],
  },
});
