# Media Engine Design

**Status:** draft for review (Sam + reviewer feedback wanted before v0.1 build)
**Date:** 2026-07-18
**Owner:** Sam (engine); compiler/product layer owned separately

This document specifies the browser-native media engine for the media agent: motivation,
architecture, the operation-graph model, execution via the Streams API, the Mediabunny
boundary, GPU transforms, the API surface exposed to the natural-language compiler, and
the verification strategy. It ends with the v0.1 plan, which deliberately starts with
throwaway proof-of-concept experiments before any production code lands in `src/`.

---

## 1. Motivation and product context

### The tool

A browser-local "media agent": the user uploads media, describes an edit in plain
language ("trim the first 10 seconds", "convert this to mkv", "concatenate these two
videos and swap the audio track"), previews the result, and clicks go. Everything
executes client-side (WebCodecs + WebGPU/WebGL + Streams API). Design principles:

- **Frictionless**: no signup, no upload, no server queue, no watermark. Sustainable
  precisely because execution is client-side — marginal cost per user is ~zero, which
  competitors with server-side GPU costs structurally cannot match.
- **Imperative, single-intent tasks** — the ffmpeg-one-liner universe, aimed at people
  for whom ffmpeg is too technical and a timeline editor is overkill. Deliberately NOT
  a video editor; complex creative workflows are out of scope by product definition.
- **SEO-native**: each high-volume search intent ("crop video", "convert mp4 to mkv")
  gets a landing page that deep-links into a pre-compiled plan. One engine, N skins.
- **Preview-before-render**: natural language is ambiguous; the preview closes the trust
  loop. The user verifies the interpretation with their eyes, not by learning syntax.

### The compiler (context — owned outside this doc)

A deterministic five-stage compiler already exists (see `docs/archive/compiler_architecture.md` — deprecated-MVP doc):
the LLM (Chrome Prompt API today; potentially tiny local models later) is a *semantic
proposer only*; deterministic TypeScript owns the final plan. The compiler's output is
the engine's input. Templated SEO intents skip the model entirely — pre-baked plans.

### Where the media engine fits

```text
user prompt ──> compiler (NL → canonical plan)          [owned by compiler layer]
                    │
                    v
              op-graph (IR)  ← THE CONTRACT (this doc, §3)
                    │
                    v
              planner (strategy: copy vs re-encode, span flattening)   [engine]
                    │
                    v
              span executor (Streams API pipelines per span)           [engine]
                    │
                    v
              Mediabunny edges (demux/decode/encode/mux)               [dependency]
              WebGPU/WebGL transforms                                  [engine]
                    │
                    v
              output file + progress + preview artifacts
```

The engine is a standalone package with no knowledge of natural language, product UI,
or the compiler's internals. Its public API is "submit a validated op-graph, receive
progress and an output." This is also the layer that could one day be open-sourced
(it composes with Mediabunny rather than competing with it).

---

## 2. Scope: the operation tiers

One criterion generates the tiering, the test strategy, and the product boundary:
**can we write a mechanical test that the output is correct?**

| Tier | Nature | Test oracle | Examples |
| --- | --- | --- | --- |
| **Tier 0 — structural** | Deterministic transforms of containers, streams, time, geometry | Exact: ffprobe-checkable postconditions | convert, compress, resize, crop, trim, concat, rotate, flip, speed, loop, add/remove/extract audio track, mute, volume, resample, normalize (EBU R128), overlay/watermark, video↔GIF, frame extraction, subtitles (soft mux + burn-in given cues), fps change |
| **Tier 1 — ML-kernel** | Pure media functions with a neural kernel inside; pluggable node implementations with a prepare/download seam | Metric thresholds (PSNR/SSIM, SNR, WER) against fixtures | upscale, denoise, transcribe, translate, background removal, filler removal |
| **Tier 2 — editorial** | Requires semantic judgment/taste | **No oracle** | highlight generation, auto-editing |

**Tier 2 is out of scope permanently, by product definition, not deferral** — that is
the sibling product (Katana) and the boundary between "omni-tool" and "editor."
Tier 1 arrives only after Tier 0 is solid; it does not shape the architecture (ML ops
are just node kernels). **v1 engine vocabulary = Tier 0, complete.**

Media kinds are `{video, audio, image, timed-text}` from day one. Still images are
first-class inputs (an overlay watermark is an image; an extracted frame is an image
output).

---

## 3. The IR: a directed acyclic op-graph

The engine's input is an **op-graph**: a DAG whose leaf nodes are sources (files,
still images, generated silence/color), whose interior nodes are operations, and whose
sinks are outputs (muxed file, image blob, canvas preview, derived artifact). Edges
carry typed media (video stream / audio stream / image / timed text).

Design decisions:

- **Functional clip algebra, not an NLE document.** There are two established models:
  the timeline-as-document (OpenTimelineIO, MLT, AVFoundation — built for *interactive*
  editing: mutation, scrubbing, undo) and the timeline-as-expression (ffmpeg
  `filter_complex`, VapourSynth — a graph of pure operations). We are a one-shot,
  immutable renderer; we need timeline *semantics*, never timeline *editing*. We take
  the expression model and steal vocabulary from OTIO where useful (rational time;
  `source_range` vs `available_range`; transitions as overlap-at-cuts).
- **Acyclic and statically validated.** A plan either validates against the engine's
  capability table (op vocabulary, parameter types, media-kind compatibility, device
  codec support) or is rejected at preflight with an actionable reason. The model never
  talks to the engine directly; the compiler emits IR, the engine disposes.
- **Rational time.** IR timestamps are rational numbers (num/den), converted to float
  seconds (Mediabunny) or int microseconds (WebCodecs) only at adapters. Unit
  conversions live in exactly one place. (Lesson learned from the prior engine:
  scattered `* 1e6` and float drift breed `Math.abs()` band-aids.)
- **Chaining is the point.** "Crop + resize + compress" is one graph. The planner
  fuses it into a single decode → GPU pass → encode traversal — no intermediate
  files, no generational quality loss, no N× decode cost.

### 3.1 Span flattening

Temporal composition (concat, loops, transitions, gap removal) is compiled — not
executed — via **span flattening**: the planner converts the graph's timeline
semantics into an ordered list of **spans**, where within each span the set of active
sources is constant.

- Concat of A and B → two spans (one source each). **Concat is not a node**; it is
  span sequencing plus timestamp rebasing at the muxer.
- A crossfade → three spans: A alone, A+B overlapping (a merge node with a
  time-parameterized blend), B alone.
- A job with no temporal structure (most v0.1 jobs) → exactly **one span**.

Each span materializes as a small static Streams-API pipeline run to completion;
spans execute sequentially into one muxer. The executor owns the seams: forced
keyframe at each span start, sample-accurate audio boundaries, monotonic rebased
timestamps. Prior art we formalize rather than reinvent: the Katana export worker's
three-coordinate time model (`source` / `clock` / `effective` per span endpoint, with
pure gap-aware conversion functions) — the one structural piece of that codebase
worth carrying forward.

The pull-based "render(t)" NLE evaluation model never exists at runtime; it is only a
planning-time idea. Execution is always push/streaming with backpressure.

---

## 4. Execution: Streams API node graph

### 4.1 The packet protocol

Exactly one edge contract for the whole engine, shared by audio and video:

- Packets: `{ payload: VideoFrame-like | AudioBlock | EncodedPacket | TimedTextCue,
  timestamp, duration }`, in presentation order (packet-domain edges: decode order,
  explicitly marked).
- **EOS is explicit**: stream closure. No counter heuristics, no watchdog timers.
- **Demand is pull-based**: Streams API backpressure (`desiredSize`, promise-returning
  `write()`) propagates end-to-end — muxer → encoder → graph → decoder → demuxer.
- **Completion is structural**: "the job is done" ⇔ the sink writables resolved.
  Per span: `await Promise.all([videoLane, audioLane, ...])`.
- Frame lifecycle is structural: every node that consumes or drops a frame closes it;
  fan-out clones per consumer.

### 4.2 Node taxonomy (~10 kinds, the complete Tier 0 vocabulary)

| Kind | Examples | Notes |
| --- | --- | --- |
| Sources | file track (via Mediabunny sink adapters), still image, silence/black generator | |
| Packet-domain time ops | trim gate, timestamp remap (speed), stream-copy pass-through | operate on encoded packets *before* decode when possible |
| Decode | Mediabunny `VideoSampleSink`/`AudioSampleSink` behind adapter | |
| Unary transforms | crop, resize, rotate, flip, color/lighting, volume, audio conform, Tier 1 kernels | declarative descriptors, GPU-fused (§6) |
| alignedMerge (fan-in) | overlay, watermark, transitions, audio mix | ffmpeg framesync semantics (§4.3) |
| conformRate | CFR conversion (fps filter contract) | terminal, on request only — VFR passes through otherwise |
| Encode | Mediabunny sample sources behind adapter | forced keyframe at span starts |
| Mux sinks | Mediabunny `Output` (file), per-track lanes incl. timed text | |
| Misc sinks | canvas preview, image blob (frame extraction), derived artifacts (transcript) | |
| tee (fan-out) | side-products during a render (thumbnails, waveform), self-composition | rare; custom implementation, never native `tee()` (§4.4) |

Operations users ask for compose from these: *convert* = source→(remux | decode→encode);
*mute* = lane routing; *extract frame* = seek + decode-one-GOP + image sink (random
access — never a full traversal); *soft subtitles* = timed-text lane muxed alongside;
*burn subtitles* = rasterize → alignedMerge.

### 4.3 Fan-in: alignedMerge (ffmpeg framesync semantics)

Modeled directly on ffmpeg's `framesync` (the machinery behind `overlay`, `blend`,
etc.), which is documented, battle-tested behavior — we adopt its semantics and its
option vocabulary rather than inventing our own:

- A **primary input** is the timing reference. Each output packet corresponds to a
  primary packet; each secondary is matched by **nearest lower-or-equal timestamp**
  (option: `nearest`), never greedy nearest-with-discards.
- EOF policy per ffmpeg: `repeatlast` (default — a secondary that ends holds its last
  frame), `eof_action: repeat | endall | pass`, `shortest`.
- The node holds ~1 packet per secondary; demand is pull-based, so buffering is
  structurally bounded regardless of input rate mismatch.
- Video and audio use the same node with different `combine` callbacks (GPU composite
  vs timestamp-windowed sample summation). Audio is mixed by **timestamp window,
  never array index**, over inputs pre-conformed to a canonical rate/layout.
- VFR is preserved through the graph (timestamps pass through); CFR is imposed only by
  an explicit terminal `conformRate` node, matching ffmpeg's `fps`/`-fps_mode=cfr`
  ("duplicate or drop frames right before encoding") — timing is resampled at most
  once, at the edge, on request.
- "Choose the slowest source as primary" survives only as a default policy for picking
  output fps when unspecified — not as an architectural role.

Offline rendering has no wall clock: sampling is deterministic, so real-time sync
machinery (jitter buffers, audio-clock-master, drift compensation) is out of scope by
construction. Motion-interpolated rate conversion and multicam clock-drift alignment
are future *policies* inside the same pull structure, not new architecture.

### 4.4 Fan-out: tee (rare, small)

Genuine fan-out cases: demux (trivial — per-track readables), side-products during a
main render (thumbnails/waveform), self-composition (PiP inset, loop-with-crossfade),
preview mirroring. The tee node reads once and enqueues `frame.clone()` per branch
(clones are independently closeable references to the same GPU resource), gating its
pull on the slowest branch. Native `ReadableStream.tee()` is forbidden: branches would
share the same frame objects (first `close()` kills both) and it buffers unboundedly
behind a slow consumer.

### 4.5 Execution strategy is the planner's decision

Per stream, per span, the planner chooses: **remux** (container swap, no codec work) /
**stream-copy** (packet pass-through, e.g. keyframe-aligned trim, codec-compatible
concat) / **smart-cut** (re-encode only boundary GOPs — later milestone) / **full
re-encode**. Ops never hardcode a strategy. This is simultaneously the speed story,
the quality story (no generational loss), and a capability essentially no browser
tool has.

---

## 5. The Mediabunny boundary

Mediabunny owns the edges: demux, decode, encode, mux, container formats, seeking,
codec ecosystem (including its ProRes WASM decoder — registered codecs come along for
free by using its decode layer). The engine owns the middle: merges, GPU transforms,
time ops, span executor, planner. Mediabunny is single-track-in/single-track-out by
design — exactly complementary; it never needs to know our topology.

**Read adapter** (~10 lines): Mediabunny's async-iterator sinks
(`sink.samples(start, end)`) wrap into a `ReadableStream` whose `pull()` calls
`it.next()` — decode happens only on demand, `cancel()` propagates to
`iterator.return()` (Mediabunny's documented cleanup path), EOS maps to `done`.

**Write adapter** (~10 lines): a `WritableStream` whose `write()` is
`await source.add(sample)` — Mediabunny's documented backpressure contract (the
promise stays pending while the encoder/muxer is busy) composes directly with
`pipeTo()`.

Contracts to respect (planner bookkeeping, not fights):

- Timestamp units: Mediabunny = float seconds; WebCodecs = int microseconds. Converted
  at adapters only (§3, rational time).
- Stream-copy path: `EncodedPacketSink.getNextPacket()` (decode order) →
  `EncodedVideoPacketSource` (requires decode order + `decoderConfig` on first add).
- Forced keyframes at span starts: `add(sample, { keyFrame: true })`.
- Early `source.close()` per finished track lane (lets the muxer plan interleaving).

Trade accepted: no direct control of decoder/encoder instances in the common path.
Escape hatch when smart-cut needs surgical control: drive a raw `VideoDecoder`/
`VideoEncoder` over `EncodedPacketSink` packets for just that GOP. Upstream access:
Sam knows the author; contract gaps get fixed upstream rather than worked around.

---

## 6. Transforms: the composite/layer spec (WebGPU/WebGL)

### 6.1 The model: one parameterized composite, not one filter per op

ffmpeg achieves transform generality with hundreds of bespoke C filters behind a
uniform pad/negotiation interface (`overlay.c`, `hstack`, `crop`, …) plus an
expression mini-language for parameters. That is viable at ffmpeg's contributor
scale and exactly wrong for a solo-maintained engine. We instead adopt the
**compositor model** (shared by NLEs, game engines, and the browser compositor):
nearly every Tier 0 spatial operation is a special case of a single parameterized
operation —

> **composite(canvas, layers)**: given a canvas size and an ordered list of layers,
> sample each layer's `srcRect` from its input, map it onto the canvas through an
> affine transform, and blend in order.

### 6.2 The spec — plain data, interpreted by ONE shader

```ts
interface Rect     { x: number; y: number; w: number; h: number }
interface Geometry { w: number; h: number }
type Mat2x3 = [a, b, c, d, e, f];   // row-major affine: x' = ax+by+c, y' = dx+ey+f

interface Layer {
  input: number;       // index into the span's input list (video lane or static image)
  srcRect: Rect;       // which part of the source frame to sample (source pixels)
  transform: Mat2x3;   // maps srcRect-local pixels onto the canvas
  opacity: number;     // straight (non-premultiplied); applied via alpha exactly once
  // blend: 'over' (enum grows later)
}
interface CompositeSpec { canvas: Geometry; layers: Layer[] }
```

A `dstRect` is accepted as authoring sugar and lowered to the matrix (scale +
translate); everything executes through one affine sampling path. The runtime is a
single WebGPU "uber-shader" (quad per layer, sample through the affine + srcRect,
src-alpha blend) with two pipeline variants: `texture_external` for video lanes
(per-frame `importExternalTexture` — zero-copy) and `texture_2d` for static images
(watermarks; uploaded once). Per-layer uniforms are written once per span; the only
per-frame uniform traffic is animated parameters (§6.4). Measured cost (E2):
0.14–0.25 ms/frame at 320x180 including import + draw + submit.

### 6.3 Ops are spec *edits*; fusion is function composition

Most operations don't survive lowering as objects — they survive as edits to the
spec, each a pure function `(spec, params, geometry) → spec`:

| Op | Lowering |
| --- | --- |
| crop | narrows the layer's `srcRect` (never renders anything itself) |
| resize | multiplies a scale into the matrix; sets canvas |
| flip | negative scale in the matrix |
| rotate 90/180/270 | exact permutation matrix; swaps canvas dims |
| pad / letterbox | grows canvas; offsets the transform |
| watermark / overlay | appends a layer |
| hstack / vstack / grid | sets canvas from geometry inference; assigns per-layer transforms |
| transitions | two layers + a time-parameterized opacity (§6.4) |

A chain (crop + resize + flip) therefore **folds into one CompositeSpec by
`reduce` before any GPU work exists** — fusion is not an optimizer pass, it's
function composition (proven in E2: the fused chain rendered as one layer, one
draw). Two properties follow: the spec is **absolute-coordinate**, so op-ordering
semantics live entirely in the IR/lowering layer and never leak into execution;
and specs are serializable data — golden-testable in Node with zero GPU
(`expect(lower(ops)).toEqual(spec)`), structured-cloneable across workers, and
exactly what SEO landing pages pre-bake.

**Canvas is a per-output constant** (one encoder, fixed dimensions), chosen by the
planner during geometry inference — every op descriptor carries
`outSize = f(inSizes, params)`, composed statically along the graph, so geometry
mismatches are plan-time errors. Mixed-resolution sources (concat, crossfade) map
onto the fixed canvas per span via their layer transforms (scale/letterbox/crop-to-
fit is a clarification-worthy policy with a default; E3 used scale-to-fill with
"larger input wins").

### 6.4 The three transform classes

1. **Geometry/compositing** — the composite spec above. Covers the entire spatial
   Tier 0 vocabulary as data.
2. **Pointwise color** — brightness/contrast/saturation/LUT as a per-layer color
   matrix/curve field; fuses into the same pass (matrices compose by
   multiplication).
3. **Neighborhood/kernel** — blur, sharpen, and every Tier 1 ML model. Genuinely
   custom shaders/models that cannot be generically parameterized; they hide behind
   the same descriptor interface as *named kernels* (`{kernel: 'upscale-2x',
   params}`) and break the fusion chain by design (`composite → kernel →
   composite`).

Time-varying parameters use **keyframed values** (the CSS/Lottie model — e.g.
`opacity: ramp(t0, t1)`), not an expression language: the compiler emits ramps, the
planner resolves them to per-frame uniform values, and nothing `eval`-shaped exists
in the engine. Transitions are exactly this: the overlap span's second layer with an
opacity ramp (proven in E3 via per-frame uniform override). If ramps ever prove
insufficient, an expression node is added then, not preemptively.

### 6.5 The two format policies

1. **Canonical working format.** One conversion at decode exit into a declared
   working format (RGBA texture, full range, rotation metadata baked, declared color
   space handling for BT.601/709 and limited/full range), one conversion at encode
   entry. Every transform in between is format-blind. Audio analogue: conform to
   canonical sample rate/layout (48 kHz float planar) at span entry; mix by timestamp
   windows thereafter.
2. **Zero-copy is a hard requirement.** `importExternalTexture` from decoded frames;
   render into a WebGPU canvas consumed directly by the encoder
   (`new VideoSample(canvas, …)`). A hidden CPU round-trip per frame is the worst
   possible perf bug in this design. (Caveat from E2: WebGPU canvases do not present
   in headless Chrome — content verification must run headed.)

Opacity/blend discipline learned the hard way (E2→E3): the shader outputs straight
color with opacity in alpha *only*; the src-alpha blend state applies it exactly
once. Reference implementation of all of §6: `experiments/lib.ts`.

---

## 7. Engine surface API (the compiler contract)

The engine exposes a small deterministic API; the NL compiler (and SEO landing pages,
and tests) are its clients:

- **`capabilities()`** → the capability table for *this device*: op vocabulary with
  parameter schemas, supported containers/codecs (WebCodecs support is
  device-dependent), media-kind compatibility, limits. The compiler must only emit
  plans the local engine can run; honest preflight failure otherwise.
- **`preflight(plan)`** → validated | rejected(reason). Not a separate validator:
  it runs the same deterministic compile used for execution (geometry inference,
  unit resolution, lowering to composite/layer specs, span planning) and stops
  before touching media. Pure and GPU-free (sub-ms), so the NL compiler can dry-run
  every model proposal through it — structured failures drive clarification or
  retry, and a validate/execute drift (plans that compile but cannot run) is
  impossible by construction. Never guesses.
- **`run(plan, options)`** → job handle with: real progress (per-span, monotonic),
  cancellation (AbortSignal propagated through every node via stream cancellation),
  and a result (file blob / image / artifacts). Retry restarts from immutable sources.
- **`preview(plan, at | range)`** (later milestone, design constraint now): previews
  are derived from the *same plan* — e.g. a low-res single-span run, or seek + decode
  + fused-transform of representative frames. Per-node preview class (exact-cheap /
  approximate / post-hoc) is recorded in the capability table so the product layer
  knows what it can promise. No parallel preview implementation is ever built.
- Versioned: the IR schema and capability table carry a schema version from day one
  (row keys stable — the existing capability-table discipline applies to the IR).

Progress, preparation seams for Tier 1 model downloads, and honest-failure semantics
follow the product layer's established rules (never-fake-success; see README).

---

## 8. Verification strategy

The engine is test-verified from day one; a capability exists when its tests pass
against real files in a real browser, not before. (This inherits the repo's
never-fake-success discipline and applies it engine-side, where today there is no
execution evidence at all.)

**Harness shape:** Playwright drives the browser to produce output files; Node
verifies them natively. Three oracle classes:

1. **Structural (ffprobe)** — container, codec, stream counts, resolution, duration ±ε,
   rotation, frame counts, A/V offset bounds. Covers convert/trim/crop/resize/concat
   geometry completely. This is the workhorse.
2. **Differential-perceptual (ffmpeg as reference)** — for re-encode paths, compare
   frames against ffmpeg's output for the same operation via SSIM/PSNR thresholds
   (never bit-exactness — different encoders legitimately differ). Measure A/V drift,
   assert a bound. Caveat: ffmpeg is a reference, not a spec — where its behavior is
   a quirk, our written postcondition wins.
3. **Metric-based (Tier 1, later)** — golden fixtures with human-set bars.

**Fixture matrix, not fixture list.** Use cases × input classes. The engine that crops
a clean 30 s MP4 is not the engine that crops a rotated iPhone HEVC VFR clip with
44.1 kHz mono audio. The matrix includes from day one: VFR phone footage, rotation
metadata, GB-scale file, odd sample rates, missing audio track, and one deliberately
truncated/corrupt file (error-path behavior is part of the contract).

**Every use case is written as intent → graph → verifiable postcondition** ("convert
to mkv" ⇒ demuxes as Matroska, stream codecs per plan, duration within ε, A/V offset
within ε). Writing the postcondition surfaces ambiguity (remux vs re-encode?) at
design time.

**Chain tests** close v0.1: e.g. crop+resize+compress as one span — asserting both
the postconditions *and* the execution shape (single fused pass, no intermediate
encode), plus memory bounds on the GB fixture with a throttled consumer (backpressure
proof).

---

## 9. v0.1 plan

### Phase 0 — throwaway experiments first (no `src/` code) — **COMPLETE 2026-07-18**

Individual standalone PoC pages, each answering foundation questions before any
production code. Run in three experiments rather than the six originally sketched
(scope merged as the work suggested); full evidence and discovered contracts in
the experiment log of the development monorepo (FINDINGS.md).

| # | What ran | Verdict |
| --- | --- | --- |
| E1 `e1-transcode` | Mediabunny ⇄ Streams adapters (sourceNode/sinkNode), transcode, throttled consumer, 1.4GB file, cancel, ffprobe oracle | **Proven.** Backpressure reaches the decoder (max 1 frame in-flight under 100x throttle); flat heap on GB input; clean abort. Discovered: no AAC encoder in Linux Chrome (negotiate codecs); negative timestamps from AAC priming (conform policy: drop/trim/clamp). |
| E2 `e2-composite` | CompositeSpec/Layer as data + ONE WebGPU uber-shader; crop/resize/flip/rotate/watermark/hstack/fused-chain; first alignedMerge; zero-copy path; SSIM-vs-ffmpeg oracle | **Proven.** Seven ops = seven spec objects, zero per-op GPU code; fusion = matrix composition; 0.14–0.25 ms/frame. Discovered: headless Chrome renders WebGPU canvases black (smokes must run headed; content oracles are mandatory); merge held-sample lifetime → clone-per-pair ownership. |
| E3 `e3-crossfade` | Three-span job (`A`, `A+B fade`, `B`) into one muxer; video opacity ramp + timestamp-windowed audio crossfade; inputs mismatched on resolution/rate/channels; conformAudio + mixCrossfade nodes | **Proven.** `for (const span of spans) await span()` is the whole executor; audio conformed to canonical format with no silent seams; per-span forced keyframes; 24s output in 2.1s wall clock. Discovered (by review): shader double-applied opacity (fixed — straight color, opacity in alpha only). |

Shared shapes accumulated in `experiments/lib.ts` (CompositeNode, source/sink/gate/
rebase/alignedMerge/conformAudio/mixCrossfade) — still experiment-grade, but they are
the reference implementations Phase 1 formalizes.

**Deferred to Phase 1 as narrow contract checks** (not worth standalone experiments):
write-side mux interleaving under lane divergence on large files; decode-error
behavior on truncated/corrupt input; stream-copy remux path
(`EncodedPacketSink → EncodedVideoPacketSource`, decode order + decoderConfig).

Findings that reveal Mediabunny contract gaps go upstream (author access), not into
workarounds.

### Phase 1 — engine package + v0.1 operations — **status 2026-07-20**

Landed in `packages/carrot/engine` (@katana-video/carrot, workspace
package; see its README for layout and harness usage). Progress exceeded the
original per-item scoping in places:

1. ✅ Clean workspace package, root app depends on it (`workspace:*`).
2. ✅ Production adapters + packet currency (Mediabunny samples, seconds).
   ⏳ The three deferred contract checks (interleaving divergence, decode
   errors, stream-copy details) are still owed as harness cases.
3. ✅ Schema landed *wider* than "minimal": full JobGraph IR shell, op-registry
   contract (four lowering families), CompiledPlan, glossary
   (`docs/vocabulary.md` is the consolidated reference).
   ⏳ The op **vocabulary entries** (names/params for the Tier 0 set) await the
   planner design pass.
4. ✅ Span executor — full multi-span (concat/loop/crossfade run today), not
   the planned degenerate version.
5. ✅ GPU transforms — full composite/layer interpreter on BOTH backends
   (WebGPU + WebGL2, premultiplied alpha, pixel-equivalent per SSIM).
6. ✅ Harness: 20 hand-authored CompiledPlans (all executable Tier 0 ops +
   combos) × both backends, 164 checks, ALL PASS. Oracles: ffprobe
   postconditions, SSIM vs ffmpeg references, volumedetect levels,
   cross-backend SSIM. ⏳ Fixture *matrix* (VFR/rotation/GB/corrupt inputs) is
   still the clean-synthetic subset.
7. ✅ Chain tests: fused crop+resize+flip (single layer, one draw) and
   trim+convert land in the same suite.

### Phase 2 — the planner (next; needs its own design pass)

The planner's skeleton is mechanically determined (validate → toposort →
geometry inference → lower → span-flatten) and its acceptance tests already
exist (every harness case is a JobGraph→CompiledPlan golden waiting for its
JobGraph). What needs genuine design — the deliberately deferred
"most opinionation" layer, ideally with the compiler owner in the loop since
this is his target language:

1. **Op vocabulary**: names + parameter shapes for the Tier 0 set (seed from
   the planner eval suite's phrasing data + the operations CSV).
2. **Ordering semantics**: chain order = user order; the general
   inverse-mapping fusion math (crop after geometric transforms).
3. **Defaults & ambiguity policy**: what gets a default (centered crop), what
   fails preflight, what surfaces as a clarification code.
4. **Unit resolution boundary**: planner accepts resolved px/seconds only;
   percentages/semantic units resolve in the compiler layer.
5. **Error taxonomy**: structured preflight failures as an API (the compiler's
   retry/clarification fuel).
6. **Strategy selection**: when `copy` may replace `reencode` (safe v0.1
   default: always reencode).

### After v0.1 (ordered by what unblocks the SEO thesis)

crop, rotate/flip, mute/volume/audio-track ops, video→GIF (non-WebCodecs encoder
node), concat (span sequencing for real), normalize (R128), speed, overlay/watermark
(alignedMerge in production), fps conform, subtitles lanes, preview surface,
transitions, Tier 1 kernels behind prepare seams.

---

## 10. Open questions

- Mediabunny container/codec write matrix (verify current support: which targets can
  be written; GIF encode path — in-library or separate encoder node?).
- `ReadableStream.from()` browser support vs the 10-line manual adapter (cosmetic).
- WebGL fallback policy for devices without WebGPU (upscaler precedent: WebGPU-only
  launch was tolerated; decide per-transform).
- Rational-time representation ergonomics in TS (library vs small hand-rolled type).
- Where the eventual open-source boundary sits (engine + IR spec public; planner
  heuristics and eval corpus private) — no action now, but keep the package boundary
  clean.

## 11. Relationship to existing repo docs

- `docs/archive/compiler_architecture.md` — the deprecated MVP's NL→plan layer (archived 2026-07-29).
- `docs/v1-capability-table.md` — snapshot of the *current* (superseded) engine layer;
  its NL-understanding column is a requirements source for the IR vocabulary; its
  honest planner↔execution gap is exactly what this engine closes.
- `src/suite.ts` — the 95-case planner eval catalog; its intents (including the
  currently-refused "Unsupported" family: video→GIF, HEIC→JPG) seed the use-case
  catalog and, later, chain-test prompts.
- The Katana export worker audit (2026-07-18 session) — source of the keeper list
  (codec probing chains, HE-AAC/SBR sample-rate special case, decoder keyframe-resync
  recovery, monotonic-mux + silence-fill invariants) to be reborn as node internals,
  and of the anti-patterns this design eliminates by construction.
