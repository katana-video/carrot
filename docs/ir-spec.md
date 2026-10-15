# Media Engine IR — Draft Specification

**Status:** v0.1 as shipped (the July draft, plus §16 — what landed since:
the deriver operations, the full effects vocabulary, captions, placement
provenance). Where §§1–15 say "future" and §16 says "shipped", §16 wins; the
machine-checkable truth is [`schema/0.1/document.json`](./schema/0.1/document.json),
generated from the engine's zod source.
**Derived from:** the 2026-07-20/21 design sessions; principles and prior-art in
[`ir-survey.md`](./ir-survey.md); execution layer in
[`design.md`](./design.md) and
`engine/src/schema.ts` (CompiledPlan — unchanged by this spec).

**Audiences:** this document is written for BOTH human reviewers and language
models. It is the seed of the generated capability prompt consumed by the NL
compiler (Prompt API / server models). Therefore: every rule is explicit and
numbered, nothing is implied, defaults are stated, and deliberate exclusions
are listed with the same weight as inclusions. Rules are tagged `[X#]` per
section for reference.

---

## 1. Architecture

Two tiers, three clocks, one projection.

**Tiers:**

```
Pipeline (outer): operations over assets & artifacts — small dataflow DAG
  └─ render operation (inner): the timeline document specified here
       └─ (lowered by the planner): per-lane span plans — never authored
```

- **[A1]** The outer tier is a dataflow DAG of coarse **operations** consuming
  **assets/artifacts** and producing **artifacts**. v0.1 defines exactly one
  operation type: `render`. (Future: `transcribe`, `denoise`, `measure-*`, …)
- **[A2]** Execution of a pipeline is topological and **static**: there are no
  conditionals anywhere in the IR. Facts known before compilation (via probe /
  MediaFacts) collapse would-be conditionals at authoring time.
- **[A3]** Artifacts are typed (`video | audio | image | timed-text | fact`).
  Audio, timed-text, and fact artifacts flow freely between operations.
  Full-length **video artifacts are a design smell** (they reintroduce
  intermediate encodes); prefer in-render processing. The pipeline declares
  which artifact(s) are deliverables; a deliverable may be a non-media artifact
  (e.g. "extract subtitles as .srt" = a pipeline with no render at all, once
  `transcribe` exists).

**Clocks** — every time value in the IR belongs to exactly one of three clocks:

- **[A4] Source time** — selects material from a source (`range` on clips and
  layers). Field names: `start` / `end`.
- **[A5] Slot time** — aligns composition layers to each other, driven by the
  base layer; per-layer `at` offsets are in slot time. Layers are NOT
  synchronized by matching source timestamps across inputs (multicam-style
  sync is a future analysis-assisted feature, not this).
- **[A6] Output time** — the derived result timeline. Only overlay windows
  reference it explicitly (field names: `from` / `to` / `duration`). Nothing
  else in the IR ever states an output-time value; all other output times are
  derived by the planner. The start/end vs from/to naming split is deliberate:
  field names encode which clock you are reading.

**Projection:**

- **[A7]** The IR describes **content**; audio/video/subtitle **lanes are a
  projection the planner performs**. Each construct has a defined contribution
  to each lane (possibly none). The IR references lanes only as *intent
  qualifiers* (`volume`, `audio: true`, `output.audio`), never as structure.
- **[A8]** Lowering is a chain of pure functions:
  `surface → normalize → resolve symbols (vs MediaFacts) → per-lane sweep →
  CompiledPlan`. Each step is deterministic and golden-testable. Document
  equality, caching, and goldens are defined on the **normalized core**, never
  the surface form.

---

## 2. Pipeline envelope

```jsonc
{
  "version": "0.1",
  "assets": {                       // opaque IDs; labels are metadata, never identity
    "v1":    { "kind": "video", "label": "intro.mp4" },
    "music": { "kind": "audio", "label": "bgm.mp3" },
    "logo":  { "kind": "image", "label": "logo.png" }
  },
  "operations": [
    { "id": "out", "op": "render", /* §3 render document */ }
  ]
  // deliverable: defaults to the last operation's output; explicit
  // "deliver": ["out"] reserved for multi-output pipelines (post-0.1).
}
```

- **[P1]** Asset IDs: opaque unique strings `^[a-zA-Z0-9_-]{1,64}$`,
  deterministically assigned by the document author (insertion-order
  convention); nothing may depend on the convention. Filenames are `label`s —
  used in errors and NL reference resolution, never lookups.
- **[P2]** References and artifact naming. An operation's `id` names its
  result (Make-style: you name the target; the `op` type is how it's
  produced). Every operation type declares — in the registry — a typed
  **default output**, referenced by the bare `id`, plus optionally **named
  ports** for multi-output operations, referenced as `id.port` (e.g.
  `"stems.vocals"`, `"caps.language"`). Port names and artifact kinds are
  per-op-type registry declarations; preflight kind-checks every reference.
- **[P2a]** Asset IDs and operation IDs share **one namespace**; a collision
  is a normalize error. A `source:` field may name an asset, a default
  output, or a port — the kind system, not the syntax, does the checking.
- **[P2b]** v0.1 documents contain exactly one operation (`render`) and no
  artifact consumers; the envelope and reference rules exist now so that
  operation types land additively later.
- **[P3]** MediaFacts (the probe result for every asset — tracks, codecs,
  durations, geometry, decodability) are available to the document author
  (i.e. injected into the NL compiler's context) and to the planner. Symbolic
  values resolve against them.

---

## 3. The render document

Five sibling fields, all optional except `timeline` (or an audio-only
equivalent) and `output`:

| Field | What it is | Section |
|---|---|---|
| `timeline` | Ordered sequence of slots: clips, compositions, transitions | §5 |
| `overlays` | Document-scoped layers over the output timeline (any kind) | §7 |
| `effects`  | Effect chain applied to the composed output | §8 |
| `output`   | Delivery specification + audio wiring | §9 |

---

## 4. Symbolic scalars

- **[S1]** Wherever the spec says *symbolic scalar*, the value is one of a
  **closed** union — this is NOT an expression language; arithmetic strings
  (`"duration - 5"`) are illegal by design:
  - a non-negative number — seconds (time) or pixels (space);
  - a **negative number** — offset from the end (Python-slice convention):
    `start: -5` = "the last 5 seconds"; `end: -2` = "until 2s before the end";
  - `'start'` / `'end'` — the endpoints;
  - a percent string `'50%'` — of the source duration (time) or of the canvas
    dimension (space).
- **[S2]** Symbols are resolved by the **planner**, exactly, in rational
  arithmetic, against MediaFacts (durations) and canvas geometry. The document
  author — human or model — never writes a computed number.
- **[S3]** Omission is the canonical "everything": a missing `range` means the
  whole source; missing `start` = 0; missing `end` = source duration. A time
  value appears in the IR **iff it is a user constraint** (survey principle 2).

---

## 5. Timeline

- **[T1]** `timeline` is an ordered array of items discriminated by `type`:
  `clip` | `composition` | `transition`. Order = output order. Sequencing is
  structural: gaps and overlaps between slots are unrepresentable.
- **[T2]** No sugar constructs exist in v0.1 — the array itself is the concat.
  (The sugar-over-canonical-core mechanism is reserved: future sugar
  normalizes into these three item types via a total `normalize()`; sugar
  groups may contain only clips — no recursion.)

### 5.1 Clip

```jsonc
{ "type": "clip",
  "source": "v1",                       // asset or artifact ID
  "range": { "start": 10, "end": -5 },  // symbolic scalars, source time; omit = whole
  "speed": 2,                           // optional; default 1
  "volume": 1,                          // optional; §10
  "effects": [ ... ]                    // optional; §8
}
```

- **[T3]** `speed` lives on the timeline side because it changes the time map.
  **Effects are duration-preserving by rule** — any operation that changes
  duration (trim, speed, loop, transition) is timeline vocabulary; any
  operation on pixels/samples (crop, resize, filters, kernels, audio effects)
  is an effect. There are no exceptions (this is the MoviePy lesson).
  Semantics (implemented): output duration = source range / speed; the binding
  carries `rate` and timestamps map as t_out = t_src/rate + offset. Audio is
  **naively resampled** — pitch shifts with speed (2× sounds an octave up);
  pitch-preserving time-stretch (the atempo equivalent) is a future refinement,
  stated, not silent. Speed ≠ 1 breaks stream-copy eligibility [D1]. Speed on
  clips only in v0.1 (not composition layers).
- **[T4]** Duration mismatches are never silently fixed: nothing in this spec
  retimes media implicitly (the editly counter-lesson). A stated duration that
  conflicts with a source is a preflight error.

### 5.2 Composition

A composition is one timeline **slot** showing multiple placed sources —
visual, audio, or mixed.

```jsonc
{ "type": "composition",
  "layers": [
    { "type": "video", "source": "v1", "volume": "50%" },              // base
    { "type": "audio", "source": "music", "volume": "30%" },
    { "type": "image", "source": "logo", "at": 2,
      "place": { "anchor": "bottom-right", "margin": 8, "width": "25%" } }
  ],
  "effects": [ ... ],       // optional; applied to the composed slot
  "duration": 12            // optional override; default = base layer duration
}
```

- **[C1]** `layers` is painter-ordered: **first = bottom**. (Note: this is the
  compositing convention; Shotstack uses the opposite — stated loudly because
  it is guessable.)
- **[C2]** The **first layer is the base**: it drives the slot's duration and
  timing (authoring mirror of slot-0-primary in execution). Other layers
  conform — held on their last frame if short, truncated if long. Explicit
  `duration` overrides.
- **[C3]** Layer `type` ∈ `video | image | audio` declares the **usage /
  projection** you want from the source — not (only) the asset's kind. A video
  asset may be used with `type: "audio"` (take its audio track only). Legal
  usages are validated against the source's actual tracks (MediaFacts);
  declaring an unavailable usage is a preflight error. The declared type also
  gates fields at the JSON-Schema level (discriminated union): `place`/
  `opacity` exist only on visual types, `volume` only on audio-contributing
  types — schema-constrained emission cannot produce a misplaced field.
- **[C4]** Layer anatomy: `{type, source, range?, at?, place?, opacity?,
  volume?, audio?, effects?}`. `range` selects in source time [A4]; `at` is a
  slot-time offset [A5] for staggered entrances (the lower-third appearing 2s
  in); `place` per §6.
- **[C5]** **Audio mix rule** (explicit, complete): the slot's audio =
  base layer's audio (plays by default) + every `type: "audio"` layer (always
  contributes) + any `type: "video"` layer with `audio: true` (muted by
  default) — each contribution scaled by its `volume`, then summed. No hidden
  ducking or auto-leveling. If the base has no audio, the mix is just the
  contributing layers.
- **[C6]** A one-layer composition is equivalent to a clip (normalize may
  canonicalize). Audio-only compositions (audio base + audio layers) are
  legal, including in audio-only timelines.

### 5.3 Transition

```jsonc
{ "type": "transition", "style": "crossfade", "duration": 1 }
```

- **[X1]** Transitions are interleaved items that must sit **between two
  slots** (clip or composition — transitions operate on slots uniformly, so
  `[composition, transition, clip]` needs no special handling). A transition
  first/last in the list, or adjacent to another transition, is a normalize
  error.
- **[X2]** **Consume semantics**: a transition of duration T overlaps the last
  T of the preceding slot with the first T of the following slot. Total output
  duration = sum of slot durations − ΣT. Each neighbor's effective duration
  (post-range, post-speed) must be ≥ its transition overlap(s); violation is a
  preflight error naming the slot. ("Handles" semantics — extending into
  unused source material instead of consuming shown content — is a future
  opt-in flag, not v0.1.)
- **[X3]** A transition ramps **both lanes** by default: video opacity ramp +
  audio gain ramps on the slots' mixed audio. (A composition's music fades out
  with its base's voice automatically, because the ramp applies to the slot's
  mix.) Lane-restricted transitions are a future flag.
- **[X4]** v0.1 styles: `crossfade`. (Style vocabulary grows via the registry.)

---

## 6. Placement (`place`)

- **[G1]** One `place` definition, referenced identically by composition
  layers and visual overlays — the two can never drift:

```jsonc
"place": {
  "anchor": "bottom-right",   // 9-point grid: top-left, top, top-right, left,
                              // center, right, bottom-left, bottom, bottom-right
  "margin": 8,                // inward from the anchored edge(s); px or '%'
  "x": 0, "y": 0,             // optional offsets in canvas coords (+x right, +y down)
  "width": "25%",             // symbolic; one dimension given → aspect preserved
  "height": null,
  "fit": "contain"            // contain | cover | fill — when a box is given
}
```

- **[G2]** `anchor` is **required** on non-base visual layers and visual
  overlays (forcing the author to commit eliminates the most likely silent
  guess). Base layers default to filling the canvas per the fit policy.
- **[G3]** Percent values resolve against the canvas dimension; the resolver is
  the same symbolic-scalar machinery as time [S2].
- **[G4]** Side-by-sides, PiP, and grids are compositions + `place` — there is
  no dedicated hstack/grid construct. ("Left half of A beside right half of B"
  = two layers, each with a crop effect and an anchored 50%-width placement.)
- **[G5]** The representation is closed under UI edits: a drag-to-reposition
  writes back as anchor + offsets (or snaps to the nearest anchor). Interactive
  adjustment is the product layer re-authoring the same document — the IR is
  the single source of truth.

---

## 7. Overlays

- **[O1]** `overlays` is a top-level field (sibling of `timeline`):
  document-scoped layers whose **window is in output time** [A6]. Any kind:

```jsonc
"overlays": [
  { "type": "image", "source": "logo", "from": "start", "to": "end",
    "place": { "anchor": "bottom-right", "margin": 8, "width": "20%" }, "opacity": 0.85 },
  { "type": "audio", "source": "music", "from": 0, "duration": 60, "volume": 0.3 }
]
```

- **[O2]** Entry anatomy = layer anatomy [C3, C4] plus the window
  (`from`/`to`/`duration`, symbolic). Same `type`-discriminated field gating;
  same usage-vs-kind validation; `place` on an audio overlay is a structured
  error.
- **[O3]** **Two scopes, by design** (neither is redundant): a layer scoped to
  a *segment* belongs in that slot's composition (window derived from
  structure — no output-time arithmetic by the author); a layer scoped to a
  *time window of the output* belongs here (explicit window — no artificial
  clip-splitting). Compiler rule of thumb: "on this part" → composition layer;
  "over the whole thing / from A to B" → overlay.
- **[O4]** A video overlay's own audio is muted by default; `audio: true` opts
  in [C5's rule, applied uniformly].
- **[O5]** **Burned captions are a `captions` overlay** — the burn counterpart
  to soft subtitles [D8], taking the same timed-text (WebVTT) assets with the
  same cue-times-are-output-times contract. The renderer is ported from
  Katana's caption renderer (word-wrap against a placement box, bottom-anchored
  block, styles: `shadow` default / `outline` / `block`). Karaoke current-word
  treatment activates only when the VTT carries inline word timestamps
  (`<00:00:02.000>` form) — with cue-level timing alone every word would be
  "current". Unlike Katana's editor, burned cues VANISH between their windows.
  `size` is a space scalar against canvas height (default `7%`); `place` is
  the wrapping box (default bottom-center, 80% × 35%, 5% margin); `font`
  defaults to a built-in (Helvetica) so rendering is network-free — Google
  Fonts names load on demand via FontFace. Execution: a caption slot has no
  binding; the executor rasterizes at each composed frame's timestamp and
  injects the frame into the composite (stills included). Captions are a
  visual contributor, so they break video stream-copy [D1]. Katana's bounce
  animation is a stated future refinement (needs per-frame rerender).

---

## 8. Effects

- **[E1]** `effects` arrays appear on clips, composition layers, compositions
  (post-composite), and at the render top level (applied to the composed
  output). Entries are a registry-derived discriminated union:
  `{ "type": "crop", "aspect": "1:1" }`, `{ "type": "resize", "height": 720 }`.
  Chain order is application order.
- **[E2]** Effects are duration-preserving, always [T3]. Effects never touch
  the time map; geometry params accept symbolic scalars.
- **[E3]** Audio effects are **excluded from 0.1** (explicit decision), and
  land pre-1.0 in these same arrays under the same duration-preserving rule.
  Expected order of arrival: volume fades, loudness normalize, EQ/compression,
  inline denoise. Ducking/sidechain: explicitly out, future.
- **[E4]** Tier 1 (model-backed) capabilities integrate in two shapes: inline
  kernel effects inside a render (upscale) and standalone operations at the
  pipeline tier (transcription, batch denoise) — chosen per capability by its
  optimal processing shape, not forced through one mold.
- **[E5]** **Lighting filters** — exactly `brightness`, `contrast`,
  `saturation`, each `{ type, amount }` with CSS-filter multiplier semantics
  (1 = unchanged; brightness scales, contrast pivots around mid-gray,
  saturation interpolates toward Rec.709 luma; 0 = grayscale). All three are
  affine color transforms, so any run of them **fuses into one 3×3+offset
  matrix per layer** (design doc §6.4 class 2) applied by both renderers on
  straight color (exact under premultiplied alpha: c' = M·c + o·a, clamped to
  [0, a]). They commute exactly with the geometry effects, so interleaving in
  the chain is free. Any lighting filter breaks stream-copy [D1]. Verified
  against ffmpeg reference implementations per-pixel (SSIM oracle), both
  backends.

---

## 9. Output & delivery

```jsonc
"output": {
  "container": "mp4",                       // mp4 | webm | mkv | mp3 | wav
  "video": { "codec": "auto", "quality": "medium" },   // codec: auto|avc|hevc|vp9|av1; or bitrate
  "audio": { "from": "music", "codec": "auto", "sampleRate": 44100 },  // from: replaces timeline audio (wiring); sampleRate: resample [D6]
  "resolution": { "width": 1920, "height": 1080 },     // optional; overrides canvas rule [V1]
  "fps": 30                                            // optional; CFR conform ON REQUEST only
}
```

- **[D1]** Delivery is a **specification, not an operation**: "convert" and
  "compress" are expressed here, not in the timeline. Per-track strategy
  (copy vs transcode) is planner output, decided independently per lane:
  *copy iff (no transforming ops on that track) ∧ (source codec legal in the
  target container per the legality table) ∧ (codec not explicitly pinned)*;
  else transcode. `codec: "auto"` means exactly this negotiation. Example: mp4
  video + mp3 replacement audio → video lane copies, audio lane transcodes to
  aac — no construct in the document says so; it falls out.

  Implemented negotiation, precisely (each condition judged on planner facts;
  any miss silently degrades to re-encode — copy is an optimization, never a
  semantic change):
  - *Untouched* means the track is the output's **only** contributor
    (no concat/transition/overlay/mix on that lane), covers the full source
    from 0 aligned 1:1 with output time (any trim breaks copy — cutting
    packets is keyframe-constrained), video net transform is the identity
    (effects, placement, canvas rule, resolution override, and top-level
    effects all fold into this one check), opacity/gain is 1 with no ramps,
    and rotation metadata is 0. Audio-only exception: truncation at the END
    is allowed (audio packets are independently decodable) — a swapped-in
    track longer than the video still copies.
  - *Legal* means the codec is in **both** the muxer's supported list and the
    engine's playback-safe preference list (PCM into mp4 is muxer-legal but
    widely unplayable, so it re-encodes).
  - *Unpinned* means no explicit `codec`, `quality`, or `bitrate` on that
    track's declaration — an explicit target is a request to encode
    ("compress" pins quality; it must never silently copy).
  - Tracks whose first packet timestamp is negative (AAC priming lead-in via
    edit list) are copy-ineligible: the output side cannot express edit
    lists. Mediabunny's own `Conversion` makes the identical call. In
    practice: AAC-in-mp4 audio usually re-encodes; the video lane — where the
    real cost lives — still copies.
- **[D2]** `audio.from` **replaces** the timeline's audio wholesale (swap).
  Amendment (2026-07-27): omitting BOTH `output.video` and `output.audio`
  means "deliver what's there" — the planner implies the available tracks
  (audio-only containers imply audio; A/V containers imply video when the
  timeline has it, plus audio). An omission is a deliberate drop ONLY when
  the other track is present. Rationale: the strict reading lowered the
  natural authoring shape `output: {container: "mp4"}` to ZERO spans with no
  error — first hit by the product path (NL-emitted documents), invisible to
  preflight, and taught by the compiler guide's own examples.
  Omitting `audio` entirely = no audio track (mute). "Music under" is NOT
  wiring — it's an audio overlay [O1] or composition layer [C5], which mix.
- **[D3]** Wired audio longer than the output is truncated to output duration
  (default); loop-to-fill is a future opt-in. Stated, not silent.
- **[D4]** Audio-only timelines are legal (`container: mp3|wav`, no video
  anywhere). A video-less timeline with a video-requiring output is a
  preflight error, not a black screen.
- **[D5]** VFR passes through by default; `fps` triggers CFR conformance at
  the edge, once, on request (the ffmpeg-decomposition decision).
- **[D6]** `audio.sampleRate` resamples the OUTPUT audio to the given rate in
  Hz — delivery intent, like `fps`, never a timeline construct. Omitted =
  keep the source rate (first contributor's, for mixes). A value equal to the
  source rate is a no-op and does not break stream-copy eligibility [D1]; a
  differing value is a transform and re-encodes. Note for oracles/users: lossy
  codecs may not preserve the requested rate in container metadata (opus
  always signals 48000); PCM outputs report it faithfully.
- **[D9]** **Animated GIF is a rendered, video-only delivery**:
  `container: "gif"` runs the normal composed render path (timeline, effects,
  overlays, transitions all apply) into the engine's own GIF encoder — the one
  hand-rolled encoder (Mediabunny has no GIF output). No audio
  (field-not-applicable), never stream-copy. v0.1 encoding: fixed 252-color
  palette + Floyd–Steinberg dithering, real-timestamp delays in centiseconds
  with error accumulation (2cs floor — browsers clamp shorter), infinite
  loop. Per-frame adaptive palettes are a stated future refinement.
  Amendment (2026-07-24, also applies to [D7] png/jpeg): pixel-only containers
  IMPLY the video track — `output.video` may be omitted and normalize
  supplies `video: {}`. Requiring the literal empty object (a side effect of
  omitted-video-means-audio-only [D2]) was a wart the NL-compile experiment
  exposed: models emitting the natural document were rejected.
- **[D8]** **Soft subtitles are delivery wiring**, like `audio.from`:
  `subtitles: { from, language? }` muxes a `timed-text` asset (WebVTT) as a
  selectable track — never touching pixels (burning is a separate future
  construct). Only video containers (mp4/webm/mkv, all WebVTT-capable) accept
  it; elsewhere it is field-not-applicable. `language` is ISO 639-2/T
  (`'eng'`), matching probe's reporting. **Cue times are OUTPUT-timeline
  times by contract** — the VTT is authored against the output; the engine
  does not retime cues through trims/concats (stated, not silent).
  `timed-text` assets appear ONLY here: on the timeline they are
  usage-unavailable, and extracting subtitle tracks from video containers is
  unsupported (Mediabunny cannot read subtitle tracks — upstream gap).
- **[D7]** **Frame extraction is an image delivery, not an operation**:
  `container: "png" | "jpeg"` plus `at` (a time scalar on the OUTPUT clock;
  default start; `'end'`/`100%` means the last frame). The still is the
  composed output at that instant — trims, effects, overlays, and transitions
  all apply, so "watermarked thumbnail at 50%" needs no special construct.
  Image outputs take no `audio` (field-not-applicable), no `codec`/`bitrate`;
  `video.quality` maps to jpeg encode quality (low/medium/high →
  0.7/0.85/0.95; png is lossless and ignores it). `at` on a non-image
  container is field-not-applicable. Executor: random-access seek-decode of
  the one composite — no muxer, no span loop.

---

## 10. Volume & the audio model

- **[M1]** `volume` may appear on any audio-contributing element (clip, layer,
  audio overlay). It is a **linear amplitude gain**: number (`1` default,
  `0.5` half amplitude, `2` boost — >1 legal) or percent sugar (`'50%'` ≡
  0.5). Applied to that element's contribution before mixing.
- **[M2]** Stated for honesty: amplitude ≠ perceived loudness (0.5× ≈ −6dB;
  "half as loud" perceptually ≈ −10dB). A dB symbolic form and perceptual
  mapping in the NL compiler are future refinements; v0.1 documents the
  physics and moves on.
- **[M3]** Transition gain ramps multiply on top of element volumes,
  orthogonally.
- **[M4]** Default audio flow: a clip carries its source's audio; sequencing
  video sequences audio with it; composition mixing per [C5]; overlays mix per
  [O1]; `output.audio.from` replaces everything per [D2]. One mechanism per
  concept — there is exactly one way to express each of: replace, mute,
  mix-under, segment-scoped mix.

---

## 11. Canvas

- **[V1]** The canvas is a **per-output constant** (one encoder). Default
  derivation: **only base video layers of timeline slots vote; the largest
  voter wins**; images and non-base layers never vote (a 4K watermark must not
  set the canvas); `output.resolution` overrides. Mixed-geometry sources map
  onto the canvas per slot via fit policy (default: scale-to-fill for base
  layers).

---

## 12. Validation & normalization (enumerated)

Normalize (structural, fact-free): transition placement [X1]; sugar expansion
(none in v0.1); one-layer composition → clip canonicalization [C6]; field
gating by declared type [C3, O2].

Preflight (fact-dependent, after symbol resolution): usage vs available tracks
[C3]; transition overlap fits neighbors [X2]; duration conflicts [T4];
video-less timeline vs output [D4]; range within source duration; kernel/op
availability on this device (tri-state: ready / needs-preparation / unsupported).

- **[N1]** All errors are structured (code + offending path + labels, never
  raw IDs alone) — they are the NL compiler's repair-and-clarification fuel.
- **[N2]** Span boundaries quantize to the frame grid (video) / sample grid
  (audio); degenerate sub-frame spans merge into a neighbor.

## 13. Lowering guarantees (informative)

The planner: resolves symbols exactly (rational arithmetic); projects the
document per-lane [A7]; sweeps each lane's boundary events independently
(an audio overlay never fragments video spans / forces keyframes — v0.1
executor may run unified spans as an acceptable interim); folds effects into
composite specs; emits per-track strategy [D1]. Clips↔spans is many-to-many;
authors never see spans.

## 14. Exclusions register (deliberate, with return paths)

| Excluded from 0.1 | Returns as |
|---|---|
| Audio effects (fades, EQ, normalize inline) | effects-array entries, pre-1.0 [E3] |
| Ducking / sidechain | future audio effect, post-1.0 |
| Handles-based transitions | opt-in transition flag [X2] |
| Lane-restricted transitions | opt-in transition flag [X3] |
| Loop-to-fill wired audio | opt-in on `output.audio` [D3] |
| dB / perceptual volume forms | symbolic-scalar extension [M2] |
| Sugar constructs (repeat/loop, …) | normalize()-expanded surface forms [T2] |
| Multi-operation pipelines, non-render operations | additive operation types [A1] |
| Multicam source-timestamp sync | analysis-assisted future feature [A5] |
| Speed rate in bindings (smart time maps), stream-copy execution | planner/executor; schema fields exist |

## 15. Worked examples

**Trim + crop + convert (single clip):**
```jsonc
{ "version": "0.1",
  "assets": { "v1": { "kind": "video" } },
  "operations": [ { "id": "out", "op": "render",
    "timeline": [ { "type": "clip", "source": "v1",
                    "range": { "start": 10, "end": 30 },
                    "effects": [ { "type": "crop", "aspect": "1:1" } ] } ],
    "output": { "container": "mkv", "video": { "codec": "auto" } } } ] }
```

**Sam's podcast case — intro with music, crossfading into the episode:**
```jsonc
"timeline": [
  { "type": "composition", "layers": [
      { "type": "video", "source": "intro" },
      { "type": "audio", "source": "music", "volume": "30%" } ] },
  { "type": "transition", "style": "crossfade", "duration": 1 },
  { "type": "clip", "source": "episode" }
]
// music is slot-scoped: fades out WITH the intro's voice via the slot-level ramp [X3]
```

**Watermark over everything + music under the first minute:**
```jsonc
"overlays": [
  { "type": "image", "source": "logo", "from": "start", "to": "end",
    "place": { "anchor": "bottom-right", "margin": 8, "width": "20%" }, "opacity": 0.85 },
  { "type": "audio", "source": "music", "from": 0, "duration": 60, "volume": 0.3 } ]
```

**Swap audio (per-track negotiation shows through `auto`):**
```jsonc
"timeline": [ { "type": "clip", "source": "v1" } ],
"output": { "container": "mp4",
            "video": { "codec": "auto" },      // → copy (untouched h264)
            "audio": { "from": "music", "codec": "auto" } }  // → transcode (mp3→aac)
```

**Side-by-side halves (no dedicated construct) [G4]:**
```jsonc
"timeline": [ { "type": "composition", "layers": [
  { "type": "video", "source": "a",
    "effects": [ { "type": "crop", "region": { "width": "50%", "anchor": "left" } } ],
    "place": { "anchor": "left", "width": "50%", "fit": "cover" } },
  { "type": "video", "source": "b",
    "effects": [ { "type": "crop", "region": { "width": "50%", "anchor": "right" } } ],
    "place": { "anchor": "right", "width": "50%", "fit": "cover" } } ] } ]
```

**Audio-only concat [D4]:**
```jsonc
"timeline": [ { "type": "clip", "source": "part1" }, { "type": "clip", "source": "part2" } ],
"output": { "container": "mp3", "audio": { "codec": "auto" } }
```

**Future shape (sketch, post-0.1): transcribe → burn** — two operations, an
artifact between them:
```jsonc
"operations": [
  { "id": "caps", "op": "transcribe", "source": "v1" },
  // "caps" names the artifact (the captions); transcribe is how it's made.
  // Bare id = the op's default output (timed-text). If transcribe also
  // exposed a port, it would be referenced as e.g. "caps.language" [P2].
  { "id": "out", "op": "render",
    "timeline": [ { "type": "clip", "source": "v1",
                    "effects": [ { "type": "burn-subtitles", "source": "caps" } ] } ],
    "output": { "container": "mp4" } } ]
```

---

## 16. v0.1 as shipped — operations, effects, captions, provenance

Everything in this section is enforced by the schema and exercised by the
[examples](./examples.md). Parameter ranges and defaults are in the field
descriptions of the JSON Schema; this section gives the shape.

### 16.1 Operations

The envelope's `operations` is a DAG [G1]: a `source` names an asset or an
earlier operation's `id`. The **last** operation's output is the deliverable
[G2]. Every non-render operation takes an optional `name` (deliverable
filename stem, no extension) and `format` (serialization when it is the
deliverable).

| `op` | Input → artifact | Fields |
|---|---|---|
| `render` | assets/artifacts → media file | `timeline` (≥1), `overlays?`, `effects?` (applied to the composed output), `output` (§9) |
| `transcribe` | video/audio with an audio track → timed-text with word timestamps [R1] | `source`, `language?` (ISO 639-1; omit = auto-detect), `model?` (`tiny`/`base`/`small`, default `base`), `format?` (`vtt`/`srt`) |
| `translate` | timed-text asset **or** a transcribe/translate artifact → timed-text, cue timings preserved [L2] | `source`, `to` (ISO 639-1), `from?` (omit = auto), `format?` |
| `removebg` | image → RGBA image, same dimensions [B1] | `source`, `model?` (`quality` default any subject; `fast` = person-only, only when speed is asked for), `format?` (`png` default / `jpeg` composites over white) |
| `transformImage` | image → image | `source`, `effects` (≥1, the same vocabulary as render effects), `format?` |
| `qrcode` | *(no source)* → square image | `text` (verbatim from the user), `ec?` (`low`/`medium`/`quartile`/`high`), `size?` (px, default 1024), `format?` |

Artifacts compose: a transcribe artifact is a valid `source` for
`output.subtitles.from` (soft track) or a `captions` overlay (burned), and for
`translate`; an image artifact (removebg, transformImage, qrcode) is a valid
overlay or layer source. Operation availability is a **host** property: a
document using `transcribe` on a host with no transcribe backend fails
preflight with `unsupported` (see [backends](./backends.md)).

```jsonc
// transcribe → translate → burn, in one document
"operations": [
  { "id": "caps", "op": "transcribe", "source": "clip", "language": "en" },
  { "id": "es",   "op": "translate",  "source": "caps", "to": "es" },
  { "id": "out",  "op": "render",
    "timeline": [{ "type": "clip", "source": "clip" }],
    "overlays": [{ "type": "captions", "source": "es", "style": "outline" }],
    "output": { "container": "mp4", "name": "clip-spanish-subtitles" } }
]
```

### 16.2 Effects vocabulary

`effects` entries are `{ "type": …, …params }`, applied in order [E1], always
duration-preserving [E2]. Any effect breaks stream-copy of the affected track
[D1].

- **Geometry:** `crop` (either `aspect: "W:H"` + optional `anchor`, or an
  explicit `region: {x?, y?, width, height}`; **`regionSource` required**, see
  §16.4), `resize` (`width`/`height`, one or both; symbolic scalars allowed),
  `rotate`, `flip`, `pad` (to an aspect, with bars — the opposite of crop;
  an optional hex `color` fills the canvas behind a BASE layer or the
  composed output — non-base layers pad transparent).
- **Lighting [E5]:** `brightness`, `contrast`, `saturation` — `{ amount }`,
  CSS-filter multiplier semantics (1 = unchanged).
- **Filters [E6]:** `grayscale`, `sepia`, `invert`, `hue-rotate`,
  `temperature`, `duotone`, `levels`, `vibrance`, `posterize`, `threshold`,
  `blur`, `sharpen`, `pixelate`, `grain`, `vignette`. Look-class filters take
  an `amount` mix in 0..1 (default 1; "slight" ≈ 0.4–0.5); `blur`/`pixelate`
  strength is the radius/block size. "Black and white" colloquially means
  `grayscale`; `threshold` is true two-tone.
- **Looks [E7]:** `{ "type": "look", "name": … , "amount"? }` with `name` ∈
  `vintage`, `noir`, `vhs`, `cinematic`, `vivid`, `dreamy`, `faded`, `summer`,
  `winter` — use for *style* asks; compose primitives only for specifics.
- **Model-backed [E4]** — legal at the **render top level only**: `upscale`
  (`scale?` default 2, `model?` tier `auto`/`fast`/`balanced`/`quality`/`ultra`),
  `denoise` (`model?` tier `auto`/`high`/`mid`/`low`), `enhance` (voice
  restoration — denoise + dereverb + bandwidth extension; speech only, mono
  out; exclusive with `denoise`), and `level` (adaptive loudness, `target?`
  LUFS default −16). The audio effects apply to the final mixed audio, in
  the order denoise/enhance → level.

### 16.3 Captions (burned subtitles)

`overlays: [{ "type": "captions", "source": <timed-text>, … }]` rasterizes
cues into pixels [O5]; cue times are output-timeline times. Optional
`style` (`shadow` default / `outline` / `block` — the karaoke-style word
highlight, needs word timestamps), `background` (dark bar), `color` (hex
accent), `font`, `size` (px or % of canvas height, default `7%`), and `place`
(the wrapping box; default bottom-center, 80% width). Soft, selectable
subtitles are `output.subtitles` [D8] instead — never both for the same ask
unless requested.

### 16.4 Placement provenance

Visual overlays (`image`, `video`) carry a **required** `placementSource`,
and every `crop` a **required** `regionSource`, each `'user' | 'assumed'`:
`'user'` when the request stated where/what ("bottom-right", "crop to
square", "cut off the bottom third"); `'assumed'` when the author defaulted
it. Hosts use `'assumed'` to offer an adjustment (drag the overlay, drag the
crop region) before the plan runs; the engine treats both identically.
`place.anchor` is one of `top-left`, `top`, `top-right`, `left`, `center`,
`right`, `bottom-left`, `bottom`, `bottom-right` (no `-center` variants).

### 16.5 Output additions since the draft

`output.container` ∈ `mp4`, `webm`, `mkv`, `mp3`, `wav`, `ogg`, `png`, `jpeg`,
`gif`; `output.name` is the deliverable's filename stem (no extension —
the host appends it). Video codecs: `auto` (copy when legal and untouched,
else the container default), `avc`, `hevc`, `vp9`, `av1` — nothing else
(no ProRes, no DNxHD: WebCodecs has no such encoders). Audio codecs: `auto`,
`aac`, `opus`, `pcm-s16`, `mp3`; `output.audio.sampleRate` resamples [D6].
`output.at` selects the instant for `png`/`jpeg` stills [D7].
`output.background` (hex) is an opaque fill behind every layer — what
transparent and uncovered pixels show (e.g. a `removebg` cut-out on a solid
color). Omitted, uncovered pixels are black in video and transparent in
`png` stills. Precedence per span: a base layer's pad `color`, then a
top-level pad `color`, then `output.background`.

