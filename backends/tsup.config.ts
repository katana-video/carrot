import { defineConfig } from 'tsup';

// One entry per subpath export; each is its own bundle so importing
// `/removebg` never pulls whisper's code (the runtimes behind them are
// optional peers, dynamic-imported inside the module that needs them).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    weights: 'src/weights.ts',
    removebg: 'src/removebg.ts',
    'denoise/index': 'src/denoise/index.ts',
    'whisper/index': 'src/whisper/index.ts',
    'translate/index': 'src/translate/index.ts',
  },
  format: ['esm'],
  dts: false, // declarations come from tsc (tsconfig.build.json) — rollup-plugin-dts cannot drive TypeScript 7
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: true,
  external: ['@katana-video/carrot', '@katana-video/web-bg-removal', '@huggingface/transformers', 'mediabunny', 'zod'],
});
