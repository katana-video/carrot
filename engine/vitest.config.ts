import { defineConfig } from 'vitest/config';

// Scoped config: without it vitest walks up to the repo-root vitest.config.ts
// (which includes only the NL-compile Level-0 tests) and finds nothing here.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
