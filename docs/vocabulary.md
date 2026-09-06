# Media Engine — Vocabulary & Types Reference

**Status:** reference snapshot of every term and type decided to date (2026-07-20).
**Authority:** `engine/src/schema.ts` is the source of truth for
types; this document is the narrative index. If they disagree, the code wins.
Design rationale lives in [`design.md`](./design.md);
empirical evidence in the experiment log of the development monorepo (FINDINGS.md).

The engine has three layers with two compilation boundaries:

```
JobGraph (IR)  ──planner──▶  CompiledPlan (spans)  ──executor──▶  output file
   authored                    deterministic                runtime
```

Each term below names exactly one thing at exactly one layer. No overlaps.

---

## 1. Data model (identity)

| Term | Definition |
| --- | --- |
| **asset** | An identified input: a video/audio file, still image, or (future) generated source. Declared in the job's asset table. |
| **asset ID** (`AssetId`) | Opaque unique string identifying an asset within one job (`^[a-zA-Z0-9_-]{1,64}$`). Deterministically assigned by whatever constructs the job (convention: insertion order — `v1`, `v2`, `img1`); nothing downstream may depend on the convention. **Filenames are never identity.** |
| **label** | Human-facing name on an asset (usually the user's filename). Used in errors, progress, and NL reference resolution. Participates in zero lookups. |
| **track** | One stream within an asset: `video`, `audio`, or `subtitles` (`TrackKind`). |
| **`TrackRef`** | `{asset, track}` — the unit that edges actually reference. Makes audio ops routing-by-construction ("swap audio" = wire `music.audio` to the output). |
| **`MediaKind`** | What an asset or flow *is*: `video` \| `audio` \| `image` \| `timed-text`. Used for edge type-checking. |

```ts
type AssetTable = Record<AssetId, { kind: MediaKind; source: Blob; label?: string }>;
```

## 2. The IR (`JobGraph`) — what clients author

| Term | Definition |
| --- | --- |
| **`JobGraph`** | The authored job: `{schemaVersion, assets, ops, output}`. JSON-serializable, zod-validated. Emitted by the NL compiler, SEO landing-page templates, or tests. |
| **op** | A user-facing operation (`crop`, `blur`, `concat`, …) — an entry in the *open* registry vocabulary. Distinct from runtime nodes (§5). |
| **`OpNode`** | One op instance in the graph: `{id, op, params?, inputs: PortRef[]}`. The `inputs` arrays ARE the DAG (adjacency by reference). |
| **`PortRef`** | An op input: either a `TrackRef` (asset track) or `{node: opId}` (another op's single output). |
| **`OutputDecl`** | Which flows feed which output tracks + container/codec/quality. **Load-bearing wiring, not just encoder config**: audio swap = point `audio.from` elsewhere; mute = omit `audio`. |
| **graph validation** | Pure planner functions, no Graph class: unique IDs, no dangling refs, acyclicity (toposort), per-op arity, media-kind type-check on every edge. |
| **geometry inference** | Static fold over topological order: every op declares `outSize = f(inSizes, params)`; all sizes known at plan time; mismatches are plan-time errors. |

## 3. The op registry — the open vocabulary

| Term | Definition |
| --- | --- |
| **`OpDef`** | One registered op: `{kind, params: zod, media: {in, out}, geometry?, lower}`. Single source of truth with five consumers: preflight validation, capability table, NL-compiler tool schemas, planner lowering, test-matrix enumeration. |
| **lowering family** | *How* an op compiles into the fixed runtime toolbox — one of four: |
| — `spec-edit` | Pure edit of the composite chain (crop, resize, flip, rotate, pad, overlay placement). Never a runtime node. |
| — `kernel` | Inserts a frame-in/frame-out runtime node (blur, sharpen, Tier 1 ML). Breaks fusion by design. Declares per-backend creators. |
| — `routing` | Track wiring (subtitle muxing, channel ops). Most routing needs no op at all — it's `OutputDecl`. |
| — `temporal` | Timeline structure (trim, concat, speed, transitions). Consumed by span flattening. |
| **`frameKernel()`** | Sugar: a bare `(frame, t) → frame` function becomes a valid kernel `OpDef`. The extensibility unit — "blur slots in" is one file + `registerOp()`. |
| **capability table** | Device-aware op availability, *generated* from the registry (codec support and GPU backend are capability dimensions — e.g. no AAC encoder in Linux Chrome). |

## 4. The composite/layer spec — transforms as data

| Term | Definition |
| --- | --- |
| **`CompositeSpec`** | `{canvas, layers}` — backend-neutral description of one rendered output frame. Interpreted identically by every renderer backend. |
| **canvas** | Output pixel dimensions. **A per-output constant** (one encoder, fixed size), chosen by the planner (default policy: largest source wins); per-span only layer mappings differ. |
| **`Layer`** | `{input: slot, srcRect, transform, opacity, blend}` — sample `srcRect` from the slot's frame, map through the affine onto the canvas, blend in order. |
| **`srcRect`** | Source region in source pixels. Crop lowers to *this* — crop never renders. |
| **`Mat2x3`** | Row-major affine `[a,b,c,d,e,f]`: `x' = ax+by+c, y' = dx+ey+f`, mapping srcRect-local pixels → canvas pixels. `dstRect` is authoring sugar lowered to it. Flips = negative scale; quarter-turns = exact permutation matrices. |
| **fusion** | Chained geometry ops fold into ONE spec by function composition (`reduce`), before any GPU work exists — not an optimizer pass. Proven: crop+resize+flip = one layer, one draw. |
| **`ParamRamp`** | `{from, to, over: [t0,t1], easing}` — keyframed parameter, the ONLY time-varying mechanism (no expression language). Transitions = second layer + opacity ramp. |
| **opacity/blend discipline** | Shaders output premultiplied color; opacity applied via alpha exactly once; blend factors `(ONE, ONE_MINUS_SRC_ALPHA)`. |

## 5. The compiled plan — constrained shapes, not a graph

| Term | Definition |
| --- | --- |
| **`CompiledPlan`** | Planner output / executor input: `{canvas, audioFormat, output, spans, strategy}` + schema version. Deliberately NOT a general graph — generality lives in the IR; the plan is a parameterized template. |
| **span** | A contiguous output-time segment `[start, end)` in which the set of active sources is constant. Spans are ordered, contiguous, non-overlapping; they execute *sequentially* into one muxer. Concat/loop = span sequencing (never a node); a crossfade = 3 spans; most jobs = 1 span. |
| **span flattening** | The planner move that compiles timeline semantics (temporal ops) into the span list, reconciling non-linear editing with linear streaming execution. |
| **`SlotBinding`** | A span's claim on a track: `{slot, asset, track, sourceStart, sourceEnd, offset}` — which part, when, playing what role. Keeps the asset ID so errors/progress trace to labels, never "input 0". |
| **slot** | Span-local dense index; the correspondence `SlotBinding.slot ↔ Layer.input` IS the wiring. A compiled artifact (like a register number) — IDs are truth above this level; indices never appear in the IR. |
| **slot 0 = primary** | Invariant: slot 0 is the timing reference (framesync role) driving the merge. Which source masters timing is a planner decision expressed by slot assignment. |
| **`staticSlots`** | `{slot → assetId}` for image assets (watermarks): no binding, no stream — bound once as textures. |
| **lane** | Per-output-track pipeline within a span: the *video lane* and *audio lane*, running concurrently (`Promise.all`), each ending at its encoder sink. `VideoLanePlan` = bindings + composite + opacity ramps (+ kernels); `AudioLanePlan` = bindings + mode (`single`\|`mix`) + gain ramps. |
| **strategy** | Per-lane execution choice, owned by the planner: `reencode` \| `copy` (stream-copy) — v0.1 emits `reencode` only; the field exists so smart paths land without schema change. |

## 6. Runtime (execution) — nodes, streams, time

| Term | Definition |
| --- | --- |
| **runtime node** | The executor's toolbox (small, near-closed set): source node = `ReadableStream`, sink node = `WritableStream`, transform node = `TransformStream`, plus merge/tee/renderer. Ops are NOT runtime nodes; they lower into configurations of these. |
| **slot stream** | The runtime materialization of one binding: Mediabunny sink → `sourceNode` adapter → boundary policy → `rebase(offset)`. Ephemeral (per span). One source can feed many slot streams (self-composition), across or within spans. |
| **packet currency** | What flows on edges: Mediabunny `VideoSample`/`AudioSample` directly (no wrappers). Timestamps in **seconds**. `clone()` = refcount; every consumer closes what it owns. |
| **boundary policy** | Ranged iterators are "covering", so span edges need policy: **video gates** (drop straddlers — frame accuracy is the best there is), **audio trims** (sample-accurate clipping in `conformAudio`). Also: no negative timestamps ever reach the muxer (AAC priming preroll is dropped/trimmed). |
| **`rebase`** | The only place source time becomes output time: timestamps + binding `offset`. |
| **`mergeSlots`** | N-ary fan-in with ffmpeg **framesync** semantics: primary-driven pull; secondaries advance to nearest timestamp ≤ primary's (`nearest-lower`); ended secondaries hold their last sample (`repeatlast`); bounded at ~1 held + 1 lookahead per secondary; emits `Map<slot, sample>` of clones — consumer owns all values. |
| **`conformAudio`** | Canonical-format node: resample (linear) + channel conform (mono→dup) + window clip + rebase, with a pass-through fast path. Mixing is by **timestamp window, never array index**. |
| **`tee`** | Clone-per-branch fan-out, slowest-branch paced. Native `ReadableStream.tee()` is forbidden for media samples (shared objects + unbounded buffering). |
| **backend / `CompositeRenderer`** | `webgpu` \| `webgl2` — two interpreters of the same `CompositeSpec`, pixel-equivalent (verified SSIM 1.0). Probe order webgpu → webgl2; backend is a capability dimension; kernels declare per-backend support. Explicit `destroy()`, never GC-reliant. |
| **executor** | The only place streams/GPU/Mediabunny instances exist. `for (const span of spans) await Promise.all(lanes)` is the whole control flow. One `Input` per asset (fresh sinks per slot stream); one muxer + encoders for all spans; forced keyframe at each span start; completion is structural (sinks resolve — no counters, no watchdogs); `AbortSignal` propagates through stream cancellation into Mediabunny teardown. |
| **time model** | IR authors decimal seconds; the planner does ALL boundary math in rationals internally; compiled plans carry resolved float seconds (`Sec`); units convert at adapters only (Mediabunny seconds ↔ WebCodecs microseconds never leak). |

## 7. Verification vocabulary

| Term | Definition |
| --- | --- |
| **structural oracle** | ffprobe assertions: streams, geometry, duration ±ε, container. The workhorse. Necessary but *insufficient* (headless Chrome encoded 2,520 black frames with perfect structure). |
| **differential oracle** | SSIM/PSNR vs an ffmpeg reference of the same operation (never bit-exact; ffmpeg is a reference, not a spec). |
| **cross-backend oracle** | SSIM between webgpu and webgl2 outputs of the same plan must be ≥0.95 (typically 1.0). Free bug-catcher for every compositing test. |
| **audio-level oracle** | volumedetect region checks (non-silence per span region; gain deltas). |
| **golden (planner)** | `expect(plan(jobGraph)).toEqual(compiledPlan)` — pure Node, no browser. Every harness case is a future golden; `example.ts` is the first. |
| **headed requirement** | WebGPU canvases never present in headless Chrome → all content-producing tests run headed (`DISPLAY` + `headless: false`). |
| **fixture matrix** | Use cases × input classes (VFR, rotation, GB-scale, odd rates, mono, corrupt). Current harness fixtures are clean/synthetic; the matrix dimension is still to be built out. |

## 8. Decided-but-not-yet-built (so the vocabulary doesn't imply otherwise)

Planner (JobGraph → CompiledPlan; `preflight()` = the same compile, stopped
before media), op vocabulary entries (names/params for the Tier 0 set — needs
its own design pass), kernel ops, stream-copy strategies, preview surface
(derived from the same plan, per-op preview class), worker host wrapper,
generated sources (silence/color/text cards), rolling-window audio mix for
long mix spans, per-binding kernel prefixes.
