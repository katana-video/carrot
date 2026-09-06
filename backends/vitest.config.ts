import { defineConfig } from 'vitest/config';

// Node-level tests: the denoise kernels against reference WAVs (needs
// `node test/fetch-denoise-vendor.mjs` once), whisper/OPUS-MT on the
// transformers.js CPU provider (models download into the HF cache on first
// run — slow, real, and the reason for the long timeout), and the
// transcribe→translate chain.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
