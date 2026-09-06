# IR Reference Survey — how existing systems specify edits as data

**Status:** input to the Phase 2 IR/vocabulary design session. Nothing here is a
decision; the synthesis section proposes principles and a strawman to argue with.
**Goal (per Sam):** a JSON specification that is (a) clean to author — for
language models above all — and (b) *predictable to lower* into the execution
layer (`CompiledPlan`: spans × composites × delivery).

Surveyed: Shotstack, Creatomate, editly (machine-authored JSON video APIs —
the closest problem match), MoviePy (decade-old programmatic editing API),
OpenTimelineIO (industry interchange), ffmpeg filtergraph (the stream-processing
contrast). Honorable mentions: JSON2Video (Shotstack-like), Remotion (frames as
React functions — different paradigm, not JSON-specifiable, excluded).

---

## 1. System profiles

### Shotstack (commercial JSON video API)

```
{ timeline: { tracks: [ { clips: [ { asset: {type, src|text}, start, length,
  trim?, volume?, transition?: {in, out}, filter?, effect? } ] } ] },
  output: { format, resolution, fps } }
```

- **Timing: absolute.** Every clip carries `start` + `length` in output seconds.
  Newer "smart" options (`auto`, `end`) exist but absolute is the native model.
- **Layering: tracks**, first = topmost. Sequencing is *emergent* — you place
  clips so they abut. The docs carry the telltale warning: *"Do not place clips
  on a track so that their start or end times overlap. This will result in the
  clips flickering."* — i.e. the schema can express invalid states, and users
  hit them (the gap/overlap bug class).
- **Effects:** per-clip `filter`/`effect`/`transform` fields — scoped correctly.
- **Transitions:** per-clip `in`/`out` (each clip fades itself), not
  between-pair. Crossfades are constructed manually via overlapping tracks.
- **Trim:** `trim` = offset into source; source range is (trim, trim+length).

**Lesson:** absolute placement is maximally expressive (arbitrary multi-track
layouts) and maximally error-prone for authors doing arithmetic — exactly what
an LLM author is worst at. Warnings-in-docs are schema bugs.

### Creatomate (commercial "RenderScript" JSON)

```
{ output_format, width, height, elements: [
  { type: video|image|audio|text|shape|composition, time?, duration?, track?, … } ] }
```

- **Timing: hybrid.** `time` (absolute) and `duration` both optional; when
  omitted, "automatically determine the length based on the content" and
  elements sequence on their track. Defaults do a lot of silent work.
- **Nesting: inline recursive** — a `composition` element contains its own
  `elements` with a local timeline. Powerful; but inline recursion is exactly
  what structured-output JSON-Schema enforcement rejects (no recursive
  schemas), and it makes documents non-canonical (same edit expressible at
  many nesting depths).
- **Effects/animations:** per-element properties + keyframe`animations`.

**Lesson:** auto-derived timing is the right default (they converged on it
too); inline recursion is the wrong encoding for our constraints — nesting, if
needed, should be by named reference (flat schema, bounded meaning).

### editly (open-source, spec-driven ffmpeg wrapper)

```
{ outPath, width, height, fps,
  defaults: { duration, transition: {name, duration}, layer: {...} },
  clips: [ { duration?, layers: [ {type: video|image|title|audio, path?, text?,
    cutFrom?, cutTo?, …} ], transition?: {name, duration} } ],
  audioTracks?: [...], audioFilePath?, keepSourceAudio? }
```

- **Timing: sequential-derived.** Clips play in order; duration comes from the
  first video layer unless overridden. No absolute output times anywhere.
- **Transitions: between adjacent clips** (gl-transitions vocabulary), with a
  global default. This maps 1:1 onto span flattening (A / overlap / B).
- **Layers within a clip**: video + title + image stack — per-segment
  compositing scoped naturally.
- **A `defaults` block** — author-side deduplication (default transition,
  default clip duration). Nice convention for terse documents.
- **Footgun: adaptive retiming.** If `clip.duration` is set, *"the video will
  be slowed/sped-up to match"* — an implicit, silent speed change. Predictable
  lowering it is not; a mismatch between stated duration and source length
  should be an error or an explicit op, never a silent time-warp.
- **Audio:** four overlapping mechanisms (layer audio, keepSourceAudio, global
  audioTracks, audioFilePath) — flexible, but four ways to say one thing.

**Lesson set:** sequential-derived timing + between-clip transitions are the
closest existing match to our span model; `defaults` is worth stealing;
implicit retiming and redundant audio mechanisms are counter-lessons.

### MoviePy (programmatic, not JSON — ontology reference)

- `Clip` = source + `subclipped(start, end)` + placement (`with_start`,
  `with_position`, `with_duration`) + `with_effects([...])` (Effect objects).
- Combinators: `concatenate_videoclips` (sequence, starts derived) and
  `CompositeVideoClip` (layer stack, explicit `with_start` placement).
- Delivery = `write_videofile(codec=, bitrate=, fps=)` kwargs.
- **The famous footgun:** trim is a clip *method* but speed is an *effect*
  (`vfx.MultiplySpeed`) — a duration-changing operation in the effects bucket.
  Effects that silently change duration break compositions built around the
  old duration. A decade of user confusion traces to this blurred boundary.

**Lesson:** the effects/timeline boundary needs a *rule*, not a convention:
**effects are duration-preserving; only timeline constructs may change the
time map.** Speed is timeline vocabulary.

### OpenTimelineIO (industry interchange)

- `Timeline → Stack (layers) → Track → {Clip, Gap, Transition}`; Clip = media
  reference + `source_range`; Transition = an item *at a cut* with
  `in_offset`/`out_offset` reaching into neighbors; effects attach to items;
  **rational time everywhere** (no float drift).
- Built for lossless NLE interchange, so it's verbose and editing-centric
  (gaps, enabled flags, markers) — more than an authoring IR wants.

**Lessons:** rational time (we already adopted, planner-side); transitions as
overlap-at-cuts (matches spans); `source_range` vs available range as the trim
formalization; but full OTIO is the wrong weight class for authoring.

### ffmpeg filtergraph (the contrast case)

Flat op-DAG with labeled pads (`[0:v]trim=...[a];[a][1:v]concat[out]`) —
maximum uniform composability, zero domain stratification. This was our
original IR draft's shape. Every *authoring-facing* system above moved away
from it; it survives where the author is a programmer composing streams.
Notably, temporal and spatial ops mix freely in one graph, and the burden of
knowing which orderings are meaningful falls entirely on the author.

---

## 2. Comparative table

| | Shotstack | Creatomate | editly | MoviePy | OTIO | ffmpeg |
|---|---|---|---|---|---|---|
| Top shape | timeline→tracks→clips | flat elements[] | clips[]→layers[] | code (clips+combinators) | timeline→stack→tracks | op DAG |
| Timing | absolute | hybrid/auto | sequential-derived | derived (concat) + absolute (composite) | ranges, rational | stream/pts |
| Sequence | emergent (abutting) | per-track auto | first-class (order) | first-class (function) | track order | concat filter |
| Effects scope | per clip | per element | per layer | per clip | per item | per node |
| Duration-changing ops | `trim` field | auto | **implicit speed (footgun)** | **speed-as-effect (footgun)** | source_range | explicit filters |
| Transitions | per-clip in/out | (animations) | **between clips** | crossfade fns | at-cut items | xfade filter |
| Nesting | no | **inline recursion** | no | code composition | stacks | graph |
| Audio | clip volume + soundtrack | audio elements | 4 mechanisms | audio clips | tracks | streams |
| Invalid states expressible | **yes (overlap warning)** | some | few | some | few | many |

---

## 3. Extracted design principles (for our IR)

1. **Structure, not arithmetic.** Sequence order derives output times; the
   planner computes them (rational, exact). LLMs never subtract durations.
   (Convergent: editly, MoviePy concat, Creatomate auto; counterexample:
   Shotstack's overlap warning.)
2. **A timestamp appears in the IR iff it is a user constraint** — trim ranges,
   overlay windows. Everything derivable is derived. No redundant state that
   can disagree.
3. **Effects are duration-preserving, by rule.** Anything touching the time map
   (trim, speed, concat, loop, transitions) is timeline vocabulary; anything
   touching pixels/samples (crop, resize, filters, kernels) is an effect.
   Formalizes the boundary MoviePy blurred and editly hid inside a default.
4. **No implicit retiming, ever.** Duration mismatches are errors or explicit
   ops. Predictable lowering means the plan is a pure function of the document
   and MediaFacts — no "helpful" silent adjustments.
5. **Between-item transitions, not per-clip in/out.** Maps 1:1 to span
   flattening (A / overlap span / B); per-clip fades are a separate effect.
6. **Sequence + scoped layers beats free-form tracks** for our domain: one
   primary sequence axis; overlays as time-scoped layers above it. Arbitrary
   NLE track layouts are editor territory (out of scope by product definition).
7. **Nesting by named reference, not inline recursion** — if/when needed at
   all. Keeps the JSON Schema non-recursive (structured-outputs constraint)
   and documents canonical.
8. **One mechanism per concept** (contra editly's four audio paths). Audio
   replacement/mute stay output wiring; clip-scoped audio effects stay effects.
9. **A `defaults` block is worth considering** for terseness (default
   transition, default fit policy) — but only if defaults resolve
   deterministically at plan time and appear resolved in the plan.
10. **Make invalid states unrepresentable** where the domain allows: gaps and
    overlaps in a sequence cannot exist if the sequence is an ordered list;
    that is the strongest argument against absolute placement as the core model.

### Added in discussion (2026-07-21) — semantic principles beyond the survey

11. **Symbolic scalars are IR values, resolved by the planner.** `start`/`end`,
    percentages, and negative-means-from-the-end (Python-slice convention:
    `start: -5` = last 5 seconds) form a closed, zod-expressible union —
    resolved deterministically against MediaFacts/geometry in the planner, so
    the LLM emits zero computed numbers. A closed vocabulary, NOT an
    expression language (no `"duration - 5"` strings — that's the eval slope).
    Omitted start/end = whole source (absence is the canonical "everything").
12. **Sugar over a canonical core.** Ergonomic surface constructs (e.g.
    `concat: [c1, c2, c3]` with a `transition` option) desugar via a total,
    deterministic `normalize()` into a small canonical core (flat sequence of
    clip/transition items, symbols resolved). Equality, goldens, caching, and
    lowering are defined on the CORE, never the surface — this reconciles
    authoring variety with canonical form. Sugar groups contain only clips
    (one level) to keep the JSON Schema non-recursive.
13. **Clips are authoring units; spans are execution segments; the mapping is
    many-to-many.** One clip → up to three spans (transitions at both ends);
    two clips share an overlap span; an overlay window splits spans. Pipeline:
    surface → normalize → resolve symbols → span-flatten → plan; each arrow a
    pure function, individually golden-testable. Predictability comes from the
    arrows, not from the IR resembling the plan.

## 3b. The outer tier: operations & artifacts (2026-07-21)

The render document above is ONE operation type inside a small outer dataflow
graph — the layer that makes this system different from every surveyed API:

- **Operation**: coarse node consuming assets/artifacts, producing artifacts.
  Examples: `transcribe(v1.audio) → captions.vtt`; `denoise(v1.audio) →
  clean-audio`; `render({timeline doc}) → output.mp4`; `measure-loudness(a) →
  fact`. Execution: topological order; still static (facts collapse
  conditionals at compile time); each render op compiles to its own
  CompiledPlan.
- **Artifact**: typed intermediate (`MediaKind` + data + metadata), name-
  referenced by later operations. Deliverables generalize: the pipeline
  declares which artifact(s) are outputs — "extract subtitles as .srt" is a
  pipeline whose final artifact IS the deliverable (no render op at all).
- **Tier 1 gets two integration shapes**: *in-line kernel* (frame-in/frame-out
  inside a render — upscale) and *standalone operation* (track-in/artifact-out
  at the model's optimal batch shape — transcription, whole-track denoise,
  two-pass loudness). Dissolves most of the windowed-kernel contract concern.
- **Fusion guardrail**: operations exist for what genuinely can't fuse.
  Audio/timed-text/fact artifacts flow freely (small); a full-length VIDEO
  artifact reintroduces intermediate encodes + generational loss — prefer
  kernels inside the render; treat video-kind artifacts as a design smell.
- Granularity note: this is the original flat ops-DAG resurrected at the
  altitude where dataflow semantics are actually true (2–3 coarse nodes),
  wrapping the stratified timeline where they weren't. No schema recursion:
  render ops contain timeline docs; timeline docs never contain operations.
- Precedents: build systems (Make: artifacts as targets, topological rules)
  and ComfyUI (coarse node-graph over artifacts, heavily LLM-familiar).
  ffmpeg and all surveyed JSON-video APIs have no equivalent — this layer is
  the differentiator. In-repo: the product compiler's schema-versioned
  `TimedTextArtifact`/`EditDecisionArtifact` land here as first-class citizens.

## 4. Strawman skeleton (to argue with, not to adopt)

```jsonc
{
  "version": "0.2",
  "assets": { "v1": {...}, "v2": {...}, "logo": {...} },   // unchanged: opaque IDs, labels
  "timeline": [                          // THE sequence axis; order = output order
    { "clip": { "source": "v1",
                "range": { "from": 10, "to": 30 },        // constraint-time only
                "speed": 2,                                // timeline-side, per rule 3
                "effects": [ { "type": "crop", "aspect": "1:1" } ] } },
    { "transition": { "type": "crossfade", "duration": 1 } },
    { "clip": { "source": "v2" } }
  ],
  "overlays": [                          // time-scoped layers above the sequence
    { "source": "logo", "from": 0, "duration": 10,
      "place": { "anchor": "bottom-right", "width": "25%" }, "opacity": 0.85 }
  ],
  "effects": [ { "type": "resize", "height": 720 } ],      // output-level chain
  "output": { "container": "mp4", "video": { "codec": "auto", "quality": "medium" },
               "audio": { "from": "music" } }               // delivery + wiring (swap/mute)
}
```

Predictable-lowering mapping (each construct → exactly one plan artifact):

| IR construct | Lowers to |
|---|---|
| `timeline` order + ranges + speed | span list + `SlotBinding` windows/offsets/rates (rational math in planner) |
| `transition` between clips | overlap span + opacity/gain `ParamRamp`s |
| `clip.effects` | that clip's spans' composite (srcRect/matrix folds) |
| `overlays` | extra layers on every span the window intersects (static slot or merge slot) |
| top-level `effects` | composite tail on every span |
| `output` | `OutputDecl` + delivery negotiation (copy vs transcode) |

## 5. Open questions for the design session

- Vocabulary finals: `timeline` vs `sequence`; `effects` vs `transforms`;
  `overlays` vs `layers`; transition entry inline-in-sequence (strawman) vs a
  `transitions` property keyed by boundary.
- Is `speed` per-clip (strawman) or a sequence-level op? (Per-clip reads
  naturally; per-rule-3 it is timeline-side either way.)
- `defaults` block: include now or never? (Rule 9's determinism condition.)
- Audio effects scoping (volume per clip? ducking later?) — one mechanism.
- Where `fit` policy lives (clip-level `fit: cover|contain|fill` vs planner
  default) for mixed-geometry sequences.
- Do we need `tracks`-style parallel video at all pre-editor-territory, or do
  `overlays` cover PiP/watermark/hstack-style needs? (hstack is an effect-like
  *composition op* — where does it live in this shape?)
```
