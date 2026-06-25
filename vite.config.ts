import { defineConfig } from 'vitest/config';

// Build timestamp, injected as a global so the running app can log which build is
// live — invaluable for telling a stale deploy from the latest fix during remote
// diagnosis (set at build time, so a rebuilt deploy shows a newer time). Uses only
// the Date global to avoid needing Node type defs in this config.
const BUILD_ID = `built ${new Date().toISOString()}`;

// Vite + Vitest config.
// The generation core (`src/core`) is pure TypeScript and is unit-tested in a
// plain Node environment with NO Three.js / DOM — this is the architectural test
// that the core/render split is correct (see CLAUDE.md §3, design/vertical-slice-build-spec.md §2).
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
  },
});
