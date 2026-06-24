import { defineConfig } from 'vitest/config';

// Vite + Vitest config.
// The generation core (`src/core`) is pure TypeScript and is unit-tested in a
// plain Node environment with NO Three.js / DOM — this is the architectural test
// that the core/render split is correct (see CLAUDE.md §3, design/vertical-slice-build-spec.md §2).
export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
    environment: 'node',
  },
});
