import { defineConfig } from 'vite';

// The harness host (`pnpm dev:harness`): serves harness/index.html and the
// fixtures run.mjs generates into harness/fixtures/ (gitignored). The port
// is pinned so the Node drivers can find it; strictPort fails loudly on a
// clash instead of silently moving.
export default defineConfig({
  root: __dirname,
  server: {
    host: '127.0.0.1',
    port: 4176,
    strictPort: true,
    fs: { allow: ['..', '../..', '../../..'] },
  },
});
