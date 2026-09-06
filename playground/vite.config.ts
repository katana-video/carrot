import { defineConfig } from 'vite';

// GitHub Pages serves the repo at /carrot/ — build and preview use that base;
// `pnpm dev` serves at /.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/carrot/' : '/',
  build: { target: 'es2023' },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', '@katana-video/web-bg-removal'] },
}));
