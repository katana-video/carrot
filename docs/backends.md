# Backends

The engine executes structural edits by itself (tier 0: everything in the
[IR spec](./ir-spec.md) that needs no model). Model-backed work plugs in
through two seams, both plain exports of `@katana-video/carrot`. The
`@katana-video/carrot-backends` package implements four of them; a host can
implement its own the same way, publicly or privately.

## The two seams

**Kernels** — per-frame or per-sample work *inside* a render (an effect on
the timeline). Registered once per worker with `registerOp()`:

```ts
import { registerOp, getOp, type FrameTransform } from '@katana-video/carrot';
import { z } from 'zod';

export function registerSharpenPlus(): void {
  if (getOp('sharpen-plus')) return;          // registration must be idempotent
  registerOp({
    kind: 'sharpen-plus',
    params: z.object({ amount: z.number().min(0).max(1) }),
    media: { in: ['video'], out: 'video' },
    geometry: (g) => g,                         // output geometry from input geometry
    lower: {
      family: 'kernel',
      backends: {
        webgpu: async (params, ctx): Promise<FrameTransform> => { /* ctx.device, ctx.geometry … */ },
        webgl2: async (params, ctx): Promise<FrameTransform> => { /* … */ },
      },
    },
  });
}
```

A `FrameTransform` is `(frame: VideoFrame, t: number) => VideoFrame | Promise<VideoFrame>`.
Provide one creator per GPU backend you support; the executor picks the
backend the run resolved to (`resolveBackend`). Audio kernels use
`family: 'audio-kernel'` and return an `AudioStreamTransform`
(`process(interleaved: Float32Array): Float32Array` + `flush()`), with the
sample rate and channel count in `ctx`. The `denoise` backend is a complete
audio-kernel example ([backends/src/denoise/index.ts](../backends/src/denoise/index.ts)).
A kernel that normalises against the WHOLE file (a level-sensitive model)
declares `prepass: 'peak'`: the executor first decodes the audio lane once
and hands `create()` the mono-mix peak as `ctx.peak` — see
[backends/src/enhance/index.ts](../backends/src/enhance/index.ts).

**Derivers** — whole-artifact work *between* renders (an operation in the
envelope whose result another operation consumes). The `DeriverBackends`
interface has one optional method per operation type:

```ts
export interface DeriverBackends {
  transcribe?(source: Blob, params: { model: string; language?: string }, ctx: DeriverCtx): Promise<Cue[]>;
  translate?(cues: Cue[], params: { to: string; from?: string }, ctx: DeriverCtx): Promise<Cue[]>;
  removebg?(source: Blob, params: Record<string, unknown>, ctx: DeriverCtx): Promise<Blob>;
}
// DeriverCtx: { signal: AbortSignal; onModelProgress?(loaded, total); onProgress?(fraction) }
```

The engine owns the pipeline — ordering, artifact kinds, progress, abort —
and calls the deriver with plain inputs. A document that names an operation
no deriver is registered for fails at preflight on that host with
`unsupported`, not at run time.

## Composing a worker

The engine runs in a worker you author, so composition is a build-time
decision and tree-shaking is real: import only the backends you ship.

```ts
// engine-worker.ts
import { createWorkerHost } from '@katana-video/carrot';
import { registerDenoise } from '@katana-video/carrot-backends/denoise';
import { removebg } from '@katana-video/carrot-backends/removebg';
import { transcribe } from '@katana-video/carrot-backends/whisper';
import { translate } from '@katana-video/carrot-backends/translate';
import { registerUpscale } from './upscale';   // a private kernel, same contract

createWorkerHost({
  init: () => { registerDenoise(); registerUpscale(); },
  derivers: { transcribe, translate, removebg },
});
```

`@katana-video/carrot/worker` is a ready-made worker with no backends for
tier-0-only hosts.

## The public backends

| Import | Op | Runtime (optional peer) | Weights | First-run download |
| --- | --- | --- | --- | --- |
| `carrot-backends/denoise` → `registerDenoise()` | `denoise` effect (`model`: auto/high → DeepFilterNet f32, mid → int8, low → RNNoise) | none — wasm fetched at first use | `cdn.katana.video/carrot/denoise/v/0.0.5/` | 0.5–14 MB |
| `carrot-backends/enhance` → `registerEnhance()` | `enhance` effect — VoiceFixer voice restoration (denoise + dereverb + bandwidth extension), 3 s chunks stitched with equal-power seams in quiet spots; mono speech out; needs WebGPU | onnxruntime-web 1.23.2 (pinned CDN import, `ortUrl` to self-host) | `cdn.katana.video/carrot/enhance/v/0.1.0/` (CC BY 4.0) | 234 MB |
| `carrot-backends/whisper` → `transcribe` | `transcribe` op (`model`: tiny/base/small; `language`) | `@huggingface/transformers` | Hugging Face hub, `onnx-community/whisper-*_timestamped` | 40–250 MB |
| `carrot-backends/translate` → `translate` | `translate` op (`to`, `from`) | `@huggingface/transformers` | Hugging Face hub, `Xenova/opus-mt-<from>-<to>` (pivots via English) | ~80 MB per pair |
| `carrot-backends/removebg` → `removebg` | `removebg` op (`model`: quality → BiRefNet-lite, fast → people-only) | `@katana-video/web-bg-removal` | web-bg-removal's CDN | 15–90 MB |

Every runtime is dynamic-imported inside the module that needs it: a host
that never runs a transcription never loads transformers.js. Downloads are
cached by the browser (Cache API / transformers.js' own cache), so the
second run is instant. WebGPU is used where the model supports it, with a
wasm fallback.

## Weights and mirroring

Defaults pull from the public hosts in the table. To serve everything from
your own origin, mirror the layout and set one option before the worker's
first run:

```ts
import { configureWeights } from '@katana-video/carrot-backends';
configureWeights({ baseUrl: 'https://models.example.com/carrot/' });
```

```
<base>/denoise/v/0.0.5/     rnnoise.wasm, dfn.wasm, dfn_weights.pack, dfn_weights_int8.pack, manifest.json, WEIGHTS_LICENSE
<base>/enhance/v/0.1.0/     chunk_3s_w16.onnx, chunk_3s_w16_weights.bin, manifest.json, WEIGHTS_LICENSE
<base>/removebg/            web-bg-removal's directory, verbatim
<base>/hf/<owner>/<model>/  a Hugging Face repo's files, flat (config.json, onnx/…)
```

Per-backend overrides exist too (`registerDenoise({ weightsBaseUrl })`,
`configureRemovebg({ weightsBaseUrl })`). Note that transformers.js' remote
settings are process-global: once a base URL is configured, *every*
transformers.js pipeline in that worker resolves against the mirror. Each
directory we publish carries a `manifest.json` (sizes + SHA-256) and a
`WEIGHTS_LICENSE`; the model licenses are reproduced in
[backends/WEIGHTS_LICENSE](../backends/WEIGHTS_LICENSE) (DeepFilterNet MIT OR
Apache-2.0, RNNoise BSD-3-Clause).

## What's not here

**Upscale.** The IR has an `upscale` effect and katana.video ships it, through
a private kernel (a fork of [websr](https://github.com/sb2702/websr) plus a
WebGL2 port, weights on a host without CORS). A document using it plans fine
on a host that registered the kernel and reports `unsupported` at preflight
elsewhere. A public `carrot-backends/upscale` is planned once the public
websr line and a CORS-served weights directory are in place.
