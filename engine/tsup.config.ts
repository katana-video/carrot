import { defineConfig } from 'tsup';

// The published shape: one ESM bundle per subpath export, shared chunks via
// code splitting, type declarations alongside. Shaders are template strings
// in source, so nothing here needs a loader.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'codec-tables': 'src/codec-tables.ts',
    'host/client': 'src/host/client.ts',
    'host/worker': 'src/host/worker.ts',
    'ir/place': 'src/ir/place.ts',
    qr: 'src/qr.ts',
    'ir/facts': 'src/ir/facts.ts',
    'executor/captions': 'src/executor/captions.ts',
    'executor/captionFonts': 'src/executor/captionFonts.ts',
  },
  format: ['esm'],
  dts: false, // declarations come from tsc (tsconfig.build.json) — rollup-plugin-dts cannot drive TypeScript 7
  clean: true,
  sourcemap: true,
  treeshake: true,
  splitting: true,
  external: ['mediabunny', 'zod', 'qrcode-generator'],
});
