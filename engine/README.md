# @katana-video/carrot

The [Carrot 🥕](https://github.com/katana-video/carrot) engine: a JSON
op-graph IR (schema, normalize, `plan()`/`preflight()`) compiled to span-based
Streams pipelines over [Mediabunny](https://mediabunny.dev) edges, with
dual-backend (WebGPU/WebGL2) compositing, a caption renderer, a GIF encoder
and an ffprobe-equivalent probe — all worker-side, browser-native, no server.
Full design: [`docs/design.md`](../docs/design.md); the IR:
[`docs/ir-spec.md`](../docs/ir-spec.md).

```
IR document  ──plan()──▶  CompiledPipeline (spans)  ──executor──▶  output file(s)
```

## Install and use

```bash
npm i @katana-video/carrot mediabunny
```

See the [repo README](../README.md#quick-start) for the worker + client
pattern. Subpath exports: `.` (IR, planner, executor, `createWorkerHost`),
`./client` (`EngineWorkerClient`), `./worker` (a ready-made tier-0 worker),
`./facts`, `./place`, `./captions`, `./caption-fonts`, `./codec-tables`, `./qr`.

## Layout

| Path | What |
| --- | --- |
| `src/schema.ts` | The contract: JobGraph IR, op registry (four lowering families), CompositeSpec, CompiledPlan, glossary + decision log |
| `src/example.ts` | Worked example: a JobGraph AND the CompiledPlan it must lower to (future planner golden test) |
| `src/nodes/` | Node library: source/sink adapters, gate/rebase/progress/tee, N-ary aligned merge (framesync semantics), audio conform + planar helpers |
| `src/render/` | CompositeRenderer seam: WebGPU + WebGL2 interpreters of the same spec (premultiplied alpha; cross-backend SSIM is a standing test oracle) |
| `src/executor/` | The executor: CompiledPlan + assets → spans → lanes → slot streams → output blob. The only place streams/GPU/Mediabunny instances exist |
| `src/ir/` | The IR (docs/ir-spec.md) + planner: zod document schema, normalize, lower (chains/sweep/ramps), plan()/preflight(), symbolic scalars, MediaFacts |
| `src/probe.ts` | ffprobe-equivalent static-facts layer over Mediabunny |
| `harness/` | Test harness: `cases.ts` (hand-authored plans), `doc-cases.ts` + `docs-check.mjs` (IR documents end-to-end), page + Node drivers with ffprobe/ffmpeg oracles |

Status: everything above is landed and green — `pnpm test` (197 unit tests:
planner goldens, executor, codec tables, captions), `harness/run.mjs` (20
render cases × 2 GPU backends) and `harness/docs-check.mjs` (IR documents
end-to-end, including the public tier-1 cases).

## Running the harness

```bash
pnpm dev:harness                          # harness host on :4176 (this package's vite.config.ts)
node engine/harness/run.mjs               # all cases, both backends
node engine/harness/run.mjs crop-left crossfade   # subset
node engine/harness/docs-check.mjs        # IR documents end-to-end (tier-1 cases use @katana-video/carrot-backends)
```

Requires ffmpeg/ffprobe and system Chrome. Runs **headed** (WebGPU canvases
render black in headless Chrome). Fixtures are generated deterministically
into `harness/fixtures/` (gitignored); `docs-check.mjs` additionally copies
the backends package's noisy-speech fixture and fetches web-bg-removal's demo
portrait.

Current suite: 20 cases × 2 GPU backends where video is involved — transcode,
convert (mkv/webm), compress, resize, crop, flip, rotate, trim, concat, loop,
watermark (premultiplied alpha), hstack-from-one-asset, crossfade (3 spans,
A/V ramps), extract-audio (wav), mute, volume, swap-audio, fused
crop+resize+flip, trim+mkv combo. Oracles: ffprobe postconditions, SSIM vs
ffmpeg references (≥0.85–0.9 observed), volumedetect levels, cross-backend
SSIM agreement (≥0.95; typically 1.0).

## Conventions

- Typecheck: `pnpm typecheck` (tsc, strict, no emit); build: `pnpm build` (tsup + tsc declarations)
- No DOM dependencies in `src/` (worker-compatible is a hard requirement).
- Runtime currency is Mediabunny `VideoSample`/`AudioSample` (seconds).
- Never `ReadableStream.tee()` on media samples; use `tee()` from
  `nodes/streams.ts` (clone-per-branch).
- Every new op: registry def + harness case(s), nothing else.
