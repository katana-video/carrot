# @katana-video/carrot-backends

Model-backed backends for [Carrot 🥕](https://github.com/katana-video/carrot),
the browser-native media engine. Each backend is its own subpath import and
plugs into the engine's kernel/deriver seams; heavy runtimes are optional
peer dependencies, dynamic-imported on first use.

```bash
npm i @katana-video/carrot @katana-video/carrot-backends mediabunny
npm i @huggingface/transformers        # for /whisper and /translate
npm i @katana-video/web-bg-removal     # for /removebg
```

```ts
// engine-worker.ts
import { createWorkerHost } from '@katana-video/carrot';
import { registerDenoise } from '@katana-video/carrot-backends/denoise';
import { removebg } from '@katana-video/carrot-backends/removebg';
import { transcribe } from '@katana-video/carrot-backends/whisper';
import { translate } from '@katana-video/carrot-backends/translate';

createWorkerHost({
  init: () => registerDenoise(),
  derivers: { transcribe, translate, removebg },
});
```

| Import | Provides | Runtime | Weights |
| --- | --- | --- | --- |
| `/denoise` | `registerDenoise()` — the `denoise` effect: DeepFilterNet (f32/int8) or RNNoise, wasm, 48 kHz | none | cdn.katana.video (see WEIGHTS_LICENSE) |
| `/enhance` | `registerEnhance()` — the `enhance` effect: VoiceFixer voice restoration on onnxruntime-web/WebGPU, 3 s chunks stitched with seam-aware equal-power crossfades; also `enhanceBuffer`, `prepareEnhance`, `enhanceSupported` | onnxruntime-web 1.23.2 (pinned CDN import) | cdn.katana.video, CC BY 4.0 (see WEIGHTS_LICENSE) |
| `/whisper` | `transcribe` deriver — whisper tiny/base/small with word timestamps; also `extractPcm16k`, `toVTT`/`toSRT` | `@huggingface/transformers` | Hugging Face hub |
| `/translate` | `translate` deriver — OPUS-MT, English pivot for exotic pairs; also `TRANSLATE_LANGUAGES`, `resolveTranslationRoute` | `@huggingface/transformers` | Hugging Face hub |
| `/removebg` | `removebg` deriver — BiRefNet-lite (quality) / people-only (fast) mattes | `@katana-video/web-bg-removal` | web-bg-removal's CDN |
| `/weights` | `configureWeights({ baseUrl })` to mirror everything from one origin | — | — |

Full contract, weights layout and mirroring:
[docs/backends.md](https://github.com/katana-video/carrot/blob/main/docs/backends.md).

## Tests

```bash
node test/fetch-denoise-vendor.mjs   # once: the denoise wasm + packs (~22 MB) into test/vendor/
pnpm test                            # denoise (Node), whisper + translate (download models on first run), chain
```

## License

MIT. Redistributed model weights carry their own licenses — see
[WEIGHTS_LICENSE](./WEIGHTS_LICENSE).
