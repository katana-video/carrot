/**
 * Media engine schema — the review artifact for Phase 1.
 *
 * Three layers, two boundaries (docs/design.md):
 *
 *   JobGraph (IR)  ──planner──▶  CompiledPlan (spans)  ──executor──▶  output
 *
 * - JobGraph is what clients author: the NL compiler, SEO landing-page
 *   templates, and tests all emit this. JSON-serializable, zod-validated.
 * - CompiledPlan is the planner's deterministic output: spans with binding
 *   tables and composite specs. Executor-facing, versioned but UNSTABLE while
 *   v0.1 shakes out. preflight() = run the planner, discard the plan.
 * - Runtime currency between nodes is Mediabunny's VideoSample/AudioSample
 *   (seconds-based timestamps); no wrapper types.
 *
 * Decision log this file encodes (settled 2026-07-18..20):
 * - Asset identity: opaque unique string IDs, deterministically assigned by
 *   the layer that constructs the job; filenames are labels, never identity.
 * - Op vocabulary (open, registry-driven) is distinct from the runtime node
 *   toolbox (small, closed-ish). Ops LOWER into the toolbox via one of four
 *   families: spec-edit | kernel | routing | temporal.
 * - Composite/layer spec is backend-neutral data; WebGPU and WebGL2 renderers
 *   are two interpreters of the same spec (dual-path from v0.1).
 * - IR time values are decimal seconds (authoring/LLM-friendly); the planner
 *   converts to rational immediately and does ALL boundary math in rational;
 *   compiled spans carry resolved float seconds (Mediabunny's unit).
 * - Alpha policy: premultiplied in the working format (straight-alpha
 *   sampling bleeds halos when scaling transparent overlays).
 *
 * GLOSSARY (each term names exactly one level; no overlaps):
 * - asset        identified input file/blob ("v1"); labels are metadata
 * - track        a stream within an asset ("v1.audio")
 * - binding      a span's claim on a track: slot + time window + offset
 * - slot stream  the runtime ReadableStream a binding materializes into
 *                (Mediabunny sink → sourceNode adapter → boundary/rebase)
 * - lane         per-output-track pipeline in a span (video lane, audio lane);
 *                a lane's slot streams converge at the merge
 * - span         contiguous output-time segment; its lanes run concurrently;
 *                spans execute sequentially into one muxer
 * - plan         ordered spans + per-output constants (canvas, audio format)
 */

import { z } from 'zod';

export const SCHEMA_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Seconds as float64. Compiled-plan values are exact by construction (planner
 * computes boundaries in rational and emits once). */
export type Sec = number;

export type MediaKind = 'video' | 'audio' | 'image' | 'timed-text';
export type TrackKind = 'video' | 'audio' | 'subtitles';
export type Backend = 'webgpu' | 'webgl2';

export interface Geometry { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** Row-major affine: x' = a·x + b·y + c ; y' = d·x + e·y + f */
export type Mat2x3 = [number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// Assets — identity model
// ---------------------------------------------------------------------------

/** Opaque unique ID. Deterministic assignment by convention (insertion order:
 * "v1", "v2", "img1"); nothing downstream may depend on the convention. */
export const assetIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export type AssetId = z.infer<typeof assetIdSchema>;

export interface AssetDecl {
  kind: MediaKind;
  /** The actual bytes. Blob/File in the browser; a path is resolved by the
   * host shell before the job reaches the engine. */
  source: Blob;
  /** Human-facing name (user filename). Used in errors/progress and by the
   * NL compiler's reference resolution. Participates in ZERO lookups. */
  label?: string;
}
export type AssetTable = Record<AssetId, AssetDecl>;

/** A specific track of a specific asset: the unit edges actually reference.
 * Makes audio ops routing-by-construction ("swap audio" = wire music.audio). */
export interface TrackRef { asset: AssetId; track: TrackKind }

// ---------------------------------------------------------------------------
// JobGraph — the IR clients author
// ---------------------------------------------------------------------------

/** An input to an op: either an asset track or another op's output. */
export type PortRef = TrackRef | { node: string };

export interface OpNode {
  /** Unique within the job; same ID rules as assets. */
  id: string;
  /** Registry op kind: 'crop', 'blur', 'concat', … */
  op: string;
  /** Validated against the OpDef's params schema at preflight. */
  params?: unknown;
  /** Most ops take 1 input; concat takes N; overlay takes 2 (base first). */
  inputs: PortRef[];
}

export interface OutputDecl {
  /** png/jpeg are single-frame image outputs (no muxer; see CompiledPlan.still);
   * gif is the animated custom-encoder output [D9] (no muxer, video only). */
  container: 'mp4' | 'webm' | 'mkv' | 'mp3' | 'wav' | 'ogg' | 'png' | 'jpeg' | 'gif';
  /** Which flow feeds each output track. Omitting audio = no audio track
   * (mute is output wiring, not an op). */
  video?: { from: PortRef; codec?: 'avc' | 'hevc' | 'vp9' | 'av1'; quality?: 'low' | 'medium' | 'high'; bitrate?: number };
  audio?: { from: PortRef; codec?: 'aac' | 'opus' | 'pcm-s16'; bitrate?: number };
  /** Soft subtitle track [D8]: a timed-text (WebVTT) asset muxed verbatim.
   * Cue times are output-timeline times by contract. */
  subtitles?: { asset: AssetId; language?: string };
  /** Output canvas override. Default: planner picks per policy (largest
   * source after geometry inference). Always a per-output constant. */
  canvas?: Geometry;
  /** CFR conformance on request only; VFR passes through otherwise. */
  fps?: number;
}

export interface JobGraph {
  schemaVersion: typeof SCHEMA_VERSION;
  assets: AssetTable;
  ops: OpNode[];
  output: OutputDecl;
}

// ---------------------------------------------------------------------------
// Composite/layer spec — backend-neutral, interpreted by one shader per backend
// ---------------------------------------------------------------------------

/**
 * One step of a filter chain (docs/filters-gpu-plan.md §3). Planner-resolved
 * absolutes only — no percents, no IR sugar. The pass planner
 * (render/filters.ts) batches consecutive pointwise steps into one generated
 * shader pass; blur is two separable passes; pixelate is a sampling pass.
 *
 * Affine color work never appears here as separate steps: lower fuses the
 * leading affine prefix of a chain into Layer.color (zero passes), and any
 * affine run AFTER a non-fusable step arrives pre-fused as one 'colorMatrix'.
 */
export type FilterStep =
  /** Fused affine batch: straight-color rgb' = matrix·rgb + offset (row-major 3×3). */
  | { op: 'colorMatrix'; matrix: [number, number, number, number, number, number, number, number, number]; offset: [number, number, number] }
  /** Input remap then gamma (straight color, per channel); inBlack/inWhite 0..1. */
  | { op: 'levels'; inBlack: number; inWhite: number; gamma: number }
  /** Luma hard cut to black/white. */
  | { op: 'threshold'; cutoff: number }
  /** Quantize each channel to N levels. */
  | { op: 'posterize'; levels: number }
  /** Saturation boost weighted toward the least-saturated pixels; −1..1. */
  | { op: 'vibrance'; amount: number }
  /** Additive noise, re-seeded per frame from render-time t; amount 0..1. */
  | { op: 'grain'; amount: number }
  /** Radial darkening; strength 0..1, size = affected fraction of the radius. */
  | { op: 'vignette'; strength: number; size: number }
  /** Separable gaussian; radius = σ in px of the texture being filtered. */
  | { op: 'blur'; radius: number }
  /** Unsharp mask: out = c + amount·(c − blur_radius(c)). */
  | { op: 'sharpen'; amount: number; radius: number }
  /** Mosaic; block size in px of the texture being filtered. */
  | { op: 'pixelate'; size: number };

export interface Layer {
  /** Span-local input slot (see SlotBinding). A compiled artifact — IDs are
   * the source of truth above this level. */
  input: number;
  /** Region of the source frame to sample, in source pixels. */
  srcRect: Rect;
  /** Maps srcRect-local pixels onto the canvas. dstRect authoring sugar is
   * lowered to this before the spec exists. */
  transform: Mat2x3;
  /** Straight value; renderers apply it via alpha exactly once (premultiplied
   * blend factors). May be animated per-frame via ParamRamp. */
  opacity: number;
  blend: 'over';
  /** Fused color transform (brightness/contrast/saturation — design doc §6.4
   * class 2): straight-color rgb' = matrix·rgb + offset, applied by renderers
   * as clamp(M·c.rgb + offset·c.a, 0, c.a) so it is exact for premultiplied
   * inputs. Omitted = identity. */
  color?: { matrix: [number, number, number, number, number, number, number, number, number]; offset: [number, number, number] };
  /** Filter passes applied to the layer's sampled srcRect BEFORE compositing
   * (per-layer chains: clip effects, overlay-layer effects). Filters see only
   * surviving (cropped) pixels — blur cannot bleed cropped-out content in. */
  filters?: FilterStep[];
}

export interface CompositeSpec {
  canvas: Geometry;
  layers: Layer[];
  /** Filter passes applied to the COMPOSED frame at canvas resolution (the
   * non-affine remainder of top-level effect chains — nonlinear ops don't
   * commute with blending, so they cannot ride per-layer the way the fused
   * affine color matrix does). */
  postFilters?: FilterStep[];
}

/** Resolved burn-in caption styling [O5] (ported from Katana's caption
 * renderer). All values are planner-resolved absolutes. */
export interface CaptionSlotSpec {
  asset: AssetId;               // timed-text (VTT) source
  style: 'shadow' | 'outline' | 'block';
  /** Highlight/accent color (hex). */
  color: string;
  font: string;
  /** Semi-transparent dark bar behind each caption line (Katana's backing
   * box, CaptionParams.shadow). */
  bar?: boolean;
  /** Text size in canvas pixels. */
  sizePx: number;
  /** Wrapping/placement region on the canvas; caption block bottom-anchors. */
  box: Rect;
}

/** Keyframed parameter (the CSS/Lottie model) — the only time-varying
 * mechanism in the engine. No expression language, ever. */
export interface ParamRamp { from: number; to: number; over: [Sec, Sec]; easing?: 'linear' }

// ---------------------------------------------------------------------------
// Op registry — the open vocabulary and how each op lowers into the toolbox
// ---------------------------------------------------------------------------

/** Single-layer chain state the spec-edit family folds over (E2's chain
 * builder, formalized). Fusion = reduce over these. */
export interface Chain { srcRect: Rect; canvas: Geometry; transform: Mat2x3 }

/** Frame-in/frame-out kernel: the extensibility unit for 'blur slots in'.
 * Tier 1 ML ops implement this same shape behind a prepare seam. */
export type FrameTransform = (frame: VideoFrame, t: Sec) => VideoFrame | Promise<VideoFrame>;

export interface KernelContext { backend: Backend; device?: GPUDevice; geometry: Geometry }

/** Streaming whole-output audio transform [H3]: interleaved f32 in the lane's
 * format in, transformed samples out. May return fewer samples than fed
 * (model latency); flush() drains the tail. One instance spans the whole
 * output — recurrent state never resets at span boundaries. */
export interface AudioStreamTransform {
  process(input: Float32Array): Float32Array | Promise<Float32Array>;
  flush(): Float32Array | Promise<Float32Array>;
}

export interface AudioKernelContext { rate: number; channels: number }

export type Lowering =
  /** Pure spec edit: crop, resize, flip, rotate, pad, overlay placement. */
  | { family: 'spec-edit'; apply: (chain: Chain, params: unknown) => Chain }
  /** Inserts a runtime kernel node; breaks the fusion chain by design.
   * Per-backend creators — capability table reports honest availability. */
  | { family: 'kernel'; backends: Partial<Record<Backend, (params: unknown, ctx: KernelContext) => FrameTransform | Promise<FrameTransform>>> }
  /** Whole-output streaming audio kernel [H3] (denoise). */
  | { family: 'audio-kernel'; create: (params: unknown, ctx: AudioKernelContext) => AudioStreamTransform | Promise<AudioStreamTransform> }
  /** Track wiring (mid-graph): subtitle muxing, channel ops. Most routing is
   * plain OutputDecl wiring and needs no op at all. */
  | { family: 'routing' }
  /** Timeline structure: trim, concat, speed, transitions. Consumed by span
   * flattening; params define the time mapping. */
  | { family: 'temporal' };

export interface OpDef {
  kind: string;
  /** zod schema — powers preflight validation, the capability table, AND the
   * NL compiler's tool/JSON schema (generated, single source of truth). */
  params: z.ZodType;
  media: { in: MediaKind[]; out: MediaKind };
  /** Geometry inference: outSize = f(inSizes, params). Required for video ops. */
  geometry?: (inputs: Geometry[], params: unknown) => Geometry;
  lower: Lowering;
}

const registry = new Map<string, OpDef>();

export function registerOp(def: OpDef): void {
  if (registry.has(def.kind)) throw new Error(`op '${def.kind}' already registered`);
  registry.set(def.kind, def);
}
export const getOp = (kind: string): OpDef | undefined => registry.get(kind);
export const listOps = (): OpDef[] => [...registry.values()];

/** Sugar for the common kernel case: author writes frame-in/frame-out only. */
export function frameKernel(
  kind: string,
  params: z.ZodType,
  backends: Extract<Lowering, { family: 'kernel' }>['backends'],
  geometry: OpDef['geometry'] = (g) => g[0]!,
): OpDef {
  return { kind, params, media: { in: ['video'], out: 'video' }, geometry, lower: { family: 'kernel', backends } };
}

// ---------------------------------------------------------------------------
// CompiledPlan — planner output, executor input (UNSTABLE while v0.1 shakes out)
// ---------------------------------------------------------------------------

/** Maps a span-local slot to an asset track and its time mapping.
 * Keeps asset IDs so progress/errors trace back to labels, never "input 0". */
export interface SlotBinding {
  slot: number;
  asset: AssetId;
  track: TrackKind;
  /** Read source range [sourceStart, sourceEnd); timestamps map into output
   * time as t_out = t_src / rate + offset (durations scale by 1/rate). */
  sourceStart: Sec;
  sourceEnd: Sec;
  offset: Sec;
  /** Playback rate: source seconds consumed per output second (speed).
   * Omitted = 1 (the map degenerates to t_out = t_src + offset). Audio at
   * rate ≠ 1 is naively resampled — pitch shifts with speed (v0.1 policy). */
  rate?: number;
}

export interface VideoLanePlan {
  /** INVARIANT: slot 0 is the primary — the timing reference driving the
   * merge's pull loop (framesync role). The planner decides which source
   * masters timing by assigning it slot 0 (default policy: slowest source). */
  bindings: SlotBinding[];
  /** [D7b] Set when NO binding drives this span (still base): the executor
   * renders the composite at this CFR instead of pulling a decode stream. */
  tick?: number;
  /** Static image assets by slot (watermarks). These slots have no binding
   * and no slot stream — the renderer binds them once as textures. */
  staticSlots?: Record<number, AssetId>;
  /** Burned-caption slots [O5]: no binding, no slot stream — the executor
   * rasterizes the referenced timed-text asset at each composed frame's
   * timestamp and injects the result as this slot's frame. The slot's layer
   * is full-canvas identity; placement lives in `box`. */
  captionSlots?: Record<number, CaptionSlotSpec>;
  composite: CompositeSpec;
  /** Per-layer opacity ramps for transitions (resolved to per-frame uniforms
   * by the executor). Sparse: layer index → ramp. */
  opacityRamps?: Record<number, ParamRamp>;
  /** Kernel insertions, in order, between composite and encode (or per-slot
   * before composite). v0.1: post-composite only. */
  kernels?: { op: string; params: unknown }[];
}

export interface AudioLanePlan {
  bindings: SlotBinding[];
  /** 'mix' carries gain ramps per slot (crossfades); 'single' is passthrough
   * through conform. */
  mode: 'single' | 'mix';
  gainRamps?: Record<number, ParamRamp>;
}

export interface Span {
  /** Output-time range [start, end). Spans are contiguous and ordered. */
  start: Sec;
  end: Sec;
  video?: VideoLanePlan;
  audio?: AudioLanePlan;
}

/** Whole-job stream-copy directive for one output track. Copy is not
 * span-driven: eligibility [D1] guarantees the source track maps 1:1 onto the
 * output timeline (offset 0, untrimmed start), so the executor pumps packets
 * once for the entire job. `end` bounds packet iteration (audio-only
 * truncation; video eligibility pins end = full source duration). */
export interface CopyTrackDecl {
  asset: AssetId;
  /** Mediabunny codec id from probe facts; validated against the container's
   * support list by the planner AND re-checked by the executor. */
  codec: string;
  end: Sec;
}

/** Whole-output model-backed video kernel [U3]: applied to every composed
 * frame between composite and encode. The executor resolves the backend
 * (websr WebGPU / webgl-upscaler WebGL2) from the host-registered kernel
 * registry; `from`→`to` includes the SDK's bicubic post-pass. */
export interface VideoKernelDecl {
  op: 'upscale';
  params: {
    model: 'auto' | 'fast' | 'balanced' | 'quality' | 'ultra';
    from: Geometry;
    to: Geometry;
  };
}

/** Whole-output model-backed audio kernel [H3]: one streaming instance wraps
 * the encoder feed across all spans (recurrent state must not reset at span
 * boundaries). Executor contract: 48 kHz mono hops internally, resample/
 * downmix around the kernel, trim the fixed lead-in delay. */
export type AudioKernelDecl =
  | { op: 'denoise'; params: { model: 'auto' | 'high' | 'mid' | 'low' } }
  | { op: 'level'; params: { target: number } };

export interface CompiledPlan {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Per-output constants (one encoder each, configured once). */
  canvas: Geometry;
  /** Present iff a geometry-changing video kernel intervenes: the composite
   * runs at this size, kernels map it to `canvas` (the encoder size). */
  compositeCanvas?: Geometry;
  /** Whole-output kernels, in order, between composite and encode. */
  videoKernels?: VideoKernelDecl[];
  audioKernels?: AudioKernelDecl[];
  audioFormat?: { rate: number; channels: number };
  output: OutputDecl;
  spans: Span[];
  /** CFR conform target [D5]: the executor's conform sink re-times decoded
   * video onto this fps grid (ffmpeg fps-filter semantics — duplicate into
   * gaps, drop same-slot frames). Absent = VFR passes through. */
  fps?: number;
  /** Execution strategy per lane, decided by the planner's [D1] negotiation:
   * copy iff the track reaches the output untouched (identity transform, full
   * range, gain 1, no ramps/mixing) ∧ its codec is container-legal ∧ the
   * declaration doesn't pin codec/quality/bitrate. Copy lanes ignore spans and
   * read `copy.*` instead. */
  strategy: { video: 'reencode' | 'copy'; audio: 'reencode' | 'copy' | 'none' };
  /** Present for each lane whose strategy is 'copy'. */
  copy?: { video?: CopyTrackDecl; audio?: CopyTrackDecl };
  /** Single-frame extraction (image containers): render the composed output at
   * this output-time instant instead of running the span loop. The executor
   * picks the span containing `time` and random-access-decodes each binding. */
  still?: {
    time: Sec;
    /** jpeg encode quality 0..1 (png ignores). */
    quality?: number;
  };
}

// ---------------------------------------------------------------------------
// CompiledPipeline [G1] — the multi-operation planner output. Steps run in
// topological order; deriver steps produce artifacts (timed-text cue lists,
// image blobs) later steps consume by id; render steps carry a CompiledPlan.
// ---------------------------------------------------------------------------

export type DeriverKind = 'transcribe' | 'translate' | 'removebg';

export interface DeriverStep {
  kind: DeriverKind;
  /** Operation id — also the artifact's id in the shared namespace [P2a]. */
  id: string;
  /** Asset or artifact id this step consumes. */
  source: string;
  params: Record<string, unknown>;
  /** Serialization at the delivery edge [G3] — meaningful only when this step
   * is the pipeline's deliverable. */
  format: 'vtt' | 'srt' | 'png' | 'jpeg';
}

export interface RenderStep {
  kind: 'render';
  id: string;
  plan: CompiledPlan;
}

/** transformImage lowered: a still-render CompiledPlan of the source image
 * with the op's effects folded in (the shipped image-as-base path [D7a]) —
 * no host backend; the executor runs the plan and publishes the encoded
 * frame as an image artifact under the op's id. */
export interface TransformImageStep {
  kind: 'transformImage';
  id: string;
  /** Asset or artifact id this step consumes (the plan references it too). */
  source: string;
  plan: CompiledPlan;
  /** Delivery-edge serialization [G3]; intermediates are always png (alpha
   * must survive downstream compositing) — the plan already encodes this. */
  format: 'png' | 'jpeg';
}

/** qrcode lowered [Q1]: the one source-less step — a pure generator the
 * executor runs itself (dynamic import of src/qr.ts; no host backend, no
 * weights). Publishes a size×size png image artifact under the op's id. */
export interface QrStep {
  kind: 'qr';
  id: string;
  params: { text: string; ec: 'low' | 'medium' | 'quartile' | 'high'; size: number };
  /** Delivery-edge serialization [G3]; intermediates stay png. */
  format: 'png' | 'jpeg';
}

export type PipelineStep = DeriverStep | QrStep | TransformImageStep | RenderStep;

export interface CompiledPipeline {
  /** Topological execution order. */
  steps: PipelineStep[];
  /** The PRIMARY deliverable: the LAST operation in authored order [G2]
   * (not necessarily last in topological order). */
  deliver: string;
  /** [G2 amendment 2026-07-29] ALL deliverables: every SINK operation
   * (output consumed by nothing downstream), authored order — "extract 3
   * frames" is three still renders, each a deliverable. Always contains
   * `deliver`. */
  deliverables: string[];
}
