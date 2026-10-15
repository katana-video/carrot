# Carrot 🥕

**A browser-native media engine with a JSON IR.** Describe an edit as data —
trim, concat, crop, overlay, burn subtitles, filters, transitions, convert —
and Carrot plans and executes it entirely in the browser with WebCodecs,
WebGPU/WebGL2 and [Mediabunny](https://mediabunny.dev). No server, no upload,
no ffmpeg.wasm. Model-backed steps (transcribe, translate, denoise, remove
background) are pluggable backends that run locally too.

Carrot is the engine behind [katana.video](https://katana.video) — the omni
tool compiles plain-language requests into this IR, and every
[katana.video/tools](https://katana.video/tools/) page is a pre-built IR
document. The compiler stays there; the engine, the IR, its schema and a
planner-verified example corpus are here, MIT.

```jsonc
{
  "version": "0.1",
  "assets": { "clip": { "kind": "video", "label": "holiday.mp4" } },
  "operations": [{
    "id": "out", "op": "render",
    "timeline": [{ "type": "clip", "source": "clip", "range": { "start": 0, "end": 10 } }],
    "effects": [{ "type": "crop", "aspect": "1:1", "regionSource": "user" }],
    "output": { "container": "webm", "name": "holiday-square" }
  }]
}
```

## Packages

| Package | What | Size |
| --- | --- | --- |
| [`@katana-video/carrot`](./engine/) | The engine: IR schema + `plan()`/`preflight()`, span executor, dual-backend (WebGPU/WebGL2) compositor, caption renderer, GIF encoder, probe, worker host + client | ~160 KB (56 KB gzip) entry |
| [`@katana-video/carrot-backends`](./backends/) | Model-backed backends behind subpath imports: `/denoise` (DeepFilterNet/RNNoise), `/enhance` (VoiceFixer), `/whisper` (transformers.js), `/translate` (OPUS-MT), `/removebg` ([web-bg-removal](https://github.com/katana-video/web-bg-removal)). Heavy runtimes are optional peers, loaded on first use | per-import |

## Quick start

```bash
npm i @katana-video/carrot mediabunny
```

```ts
// worker.ts — the engine runs in a worker; this file IS the worker
import { createWorkerHost } from '@katana-video/carrot';
createWorkerHost();   // add backends here (see docs/backends.md)
```

```ts
// main.ts
import { plan } from '@katana-video/carrot';
import { EngineWorkerClient } from '@katana-video/carrot/client';
import EngineWorker from './worker?worker';   // Vite; any bundler's worker syntax works

const engine = new EngineWorkerClient(new EngineWorker());
const file: File = /* from an <input type=file> */;
const facts = { clip: await engine.probeFacts(file) };  // tracks, codecs, duration, geometry

const { pipeline, errors } = plan(document, facts);      // the JSON above
if (!pipeline) throw new Error(errors.map((e) => `${e.code}@${e.path}: ${e.message}`).join('\n'));

const { blob } = await engine.runPipeline(pipeline, { clip: { kind: 'video', blob: file } }, {
  onProgress: (p) => console.log(p.mediaTime / p.totalDuration),
});
```

`plan()` is synchronous and pure: it validates the document against the
schema, normalizes it, and lowers it to an executable plan against the
assets' probed facts — so a host can preflight a document (and quote what a
run needs) before touching any media. Stream-copy is negotiated per track: a
"convert" that changes nothing about a track never re-encodes it.

## Documentation

- [**IR specification**](./docs/ir-spec.md) — the normative document format:
  envelope, timeline (clips, compositions, transitions), placement, overlays,
  effects, output & delivery, audio model, validation rules.
- [**Worked examples**](./docs/examples.md) — 60+ natural-language requests
  with the IR documents produced for them, each re-validated by the planner.
- [**JSON Schema**](./docs/schema/0.1/document.json) — generated from the zod
  source of truth; also served at
  `https://katana-video.github.io/carrot/schema/0.1/document.json`.
- [**Backends**](./docs/backends.md) — the two extension seams (kernels,
  derivers), composing a worker, weights and mirroring.
- [**Design**](./docs/design.md), [**vocabulary**](./docs/vocabulary.md),
  [**IR survey**](./docs/ir-survey.md) — how and why the engine is shaped this
  way.
- [**Playground**](https://katana-video.github.io/carrot/) — paste a document,
  drop files, plan, run.

Writing documents with a language model? Point it at `llms.txt` — it lists
the spec, the schema and the examples in the order a model should read them.

## Status

v0.2.0. The engine, IR and planner have been in production at katana.video
since July 2026 (omni + 15 tool pages). 0.2.0 adds solid render backgrounds
(`output.background`, filled pad colors) and voice enhancement (`enhance`,
with the executor's peak pre-pass for whole-file-normalised kernels).
Public tiers: everything structural (tier 0) plus denoise, enhance, transcribe,
translate and background removal. Upscaling ships in the hosted product
through a private backend and is not in this release (see
[backends](./docs/backends.md#whats-not-here)).

Browser support: Chromium (WebCodecs + WebGPU, WebGL2 fallback for the
compositor). Firefox and Safari WebCodecs coverage is tracked upstream in
Mediabunny.

## Development

```bash
pnpm install
pnpm test                   # engine: planner goldens, executor units (197)
pnpm test:backends          # backends: needs `node backends/test/fetch-denoise-vendor.mjs` once; whisper/translate download models
pnpm dev:harness            # engine harness host on :4176, then:
node engine/harness/run.mjs         # 20 render cases × 2 GPU backends, ffprobe/SSIM oracles (headed Chrome)
node engine/harness/docs-check.mjs  # IR documents end-to-end, incl. the public tier-1 cases
pnpm build                  # tsup + tsc declarations for both packages
pnpm gen:schema             # regenerate docs/schema from the zod source
```

## License

MIT — see [LICENSE](./LICENSE). Model weights redistributed by the backends
package carry their own licenses, listed in
[backends/WEIGHTS_LICENSE](./backends/WEIGHTS_LICENSE).
