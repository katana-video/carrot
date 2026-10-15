/**
 * The IR document schema — zod encoding of docs/ir-spec.md.
 *
 * Constraints honored for schema-enforced LLM emission (structured outputs /
 * Prompt API responseConstraint):
 * - no recursive schemas (compositions contain layers, never timelines)
 * - discriminated unions on `type` (field gating happens at the schema level)
 * - range/fact-dependent checks live in normalize/preflight, not the schema
 * - every field described (descriptions are prompt surface)
 *
 * Rule tags [A1], [T3], … reference the spec document.
 */

import { z } from 'zod';

export const IR_VERSION = '0.1';

// ---------------------------------------------------------------------------
// Symbolic scalars [S1–S3] — a CLOSED union, not an expression language.
// ---------------------------------------------------------------------------

const percent = z.string().regex(/^-?\d+(\.\d+)?%$/).describe(
  "Percentage string like '50%' — of source duration (time) or canvas dimension (space)");

/** Time scalar: seconds; negative = from the end (Python-slice); 'start'/'end'; '%'. */
export const timeScalarSchema = z.union([
  z.number().describe('Seconds. Negative means offset from the end: -5 = last 5 seconds'),
  z.enum(['start', 'end']),
  percent,
]).describe('Symbolic time value, resolved exactly by the planner');
export type TimeScalar = z.infer<typeof timeScalarSchema>;

/** Space scalar: pixels or percent of the relevant canvas dimension. */
export const spaceScalarSchema = z.union([
  z.number().describe('Pixels'),
  percent,
]).describe('Symbolic space value, resolved against canvas geometry');
export type SpaceScalar = z.infer<typeof spaceScalarSchema>;

/** Volume: linear amplitude gain [M1]. Number (1 = unchanged, >1 boost) or percent sugar. */
export const volumeSchema = z.union([
  z.number().describe('Linear amplitude gain: 1 = unchanged, 0.5 = half amplitude, 2 = boost'),
  percent,
]).describe('Linear amplitude gain (note: 0.5 is -6dB, not "half as loud" perceptually)');
export type Volume = z.infer<typeof volumeSchema>;

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)
  .describe('Opaque reference: an asset ID, an operation ID (its default output), or opId.port');
// references may also be "opId.port" [P2]
const refSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}(\.[a-zA-Z0-9_-]{1,32})?$/)
  .describe('Source reference: asset ID, operation ID, or opId.port');

export const rangeSchema = z.object({
  start: timeScalarSchema.optional().describe('Source-time start; omit = 0 [S3]'),
  end: timeScalarSchema.optional().describe('Source-time end; omit = source duration [S3]'),
}).strict().describe('Selects material from the source, in SOURCE time [A4]');
export type Range = z.infer<typeof rangeSchema>;

// ---------------------------------------------------------------------------
// Placement [G1–G3] — one definition, referenced by layers and overlays.
// ---------------------------------------------------------------------------

export const placeSchema = z.object({
  anchor: z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right',
    'bottom-left', 'bottom', 'bottom-right'])
    .describe('9-point anchor on the canvas'),
  margin: spaceScalarSchema.optional().describe('Inward distance from the anchored edge(s)'),
  x: spaceScalarSchema.optional().describe('Extra offset, canvas coords (+x right)'),
  y: spaceScalarSchema.optional().describe('Extra offset, canvas coords (+y down)'),
  width: spaceScalarSchema.optional().describe('Target width; if height omitted, aspect is preserved'),
  height: spaceScalarSchema.optional().describe('Target height; if width omitted, aspect is preserved'),
  fit: z.enum(['contain', 'cover', 'fill']).optional()
    .describe('How the source maps into its box when both dimensions constrain it'),
}).strict().describe('Placement on the canvas [G1]. Same schema for composition layers and overlays [E2]');
export type Place = z.infer<typeof placeSchema>;

// ---------------------------------------------------------------------------
// Effects [E1–E2] — duration-preserving by rule [T3]. Registry: 6 geometry
// entries + 3 lighting filters [E5] (fused to one color matrix per layer).
// ---------------------------------------------------------------------------

/** Like placementSource on overlays: whether the crop's target came from the
 *  user's words or was defaulted. 'assumed' crops are resolved by the user
 *  dragging the region in the app before the plan runs. */
const regionSourceSchema = z.enum(['user', 'assumed'])
  .describe("'user' when the request states what to crop to or keep ('crop to square', 'crop out the bottom third'); 'assumed' when it's vague ('crop this') and you defaulted. Never ask what to crop — default a centered region and mark 'assumed'");

const cropAspect = z.object({
  type: z.literal('crop'),
  aspect: z.string().regex(/^\d+:\d+$/).describe("Target aspect ratio like '1:1' or '9:16'"),
  anchor: z.enum(['top-left', 'top', 'top-right', 'left', 'center', 'right',
    'bottom-left', 'bottom', 'bottom-right']).optional()
    .describe('Which part to keep; default center'),
  regionSource: regionSourceSchema,
}).strict().describe('Crop to an aspect ratio, keeping the anchored region');

const cropRegion = z.object({
  type: z.literal('crop'),
  region: z.object({
    x: spaceScalarSchema.optional().describe('Region left edge in source space; default 0'),
    y: spaceScalarSchema.optional().describe('Region top edge in source space; default 0'),
    width: spaceScalarSchema.describe('Region width in source space'),
    height: spaceScalarSchema.describe('Region height in source space'),
  }).strict(),
  regionSource: regionSourceSchema,
}).strict().describe('Crop to an explicit region of the source (UI-adjustable form)');

const resizeEffect = z.object({
  type: z.literal('resize'),
  width: spaceScalarSchema.optional().describe('Target width; omit to derive from height (aspect preserved)'),
  height: spaceScalarSchema.optional().describe('Target height; omit to derive from width (aspect preserved)'),
}).strict().describe('Resize; one dimension given preserves aspect, both given is exact (may distort)');

const rotateEffect = z.object({
  type: z.literal('rotate'),
  degrees: z.union([z.literal(90), z.literal(180), z.literal(270)])
    .describe('Clockwise quarter-turns only in v0.1 (exact, no resampling)'),
}).strict();

const flipEffect = z.object({
  type: z.literal('flip'),
  axis: z.enum(['horizontal', 'vertical']).describe('horizontal = mirror left/right'),
}).strict();

const padEffect = z.object({
  type: z.literal('pad'),
  aspect: z.string().regex(/^\d+:\d+$/).describe("Target aspect like '9:16' — adds bars (letterbox/pillarbox)"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
    .describe('Bar color (fills the canvas behind the content); default black for video, transparent for image outputs'),
}).strict().describe('Pad to a target aspect with bars — the opposite of crop (e.g. landscape into portrait)');

// Lighting filters [E5] — multiplier conventions match CSS filter functions.
const brightnessEffect = z.object({
  type: z.literal('brightness'),
  amount: z.number().min(0).max(10)
    .describe('Multiplier: 1 = unchanged, 1.5 = brighter, 0.5 = darker'),
}).strict();

const contrastEffect = z.object({
  type: z.literal('contrast'),
  amount: z.number().min(0).max(10)
    .describe('Multiplier around mid-gray: 1 = unchanged, >1 punchier, 0 = flat gray'),
}).strict();

const saturationEffect = z.object({
  type: z.literal('saturation'),
  amount: z.number().min(0).max(10)
    .describe('Multiplier: 1 = unchanged, 0 = grayscale, >1 more vivid'),
}).strict();

// Filter effects [E6] — batch-1 vocabulary (docs/filters-gpu-plan.md §5).
// Look-class effects carry a 0..1 amount mix (defaulted — "slight sepia" is
// amount ~0.4); blur/pixelate strength IS the radius/block size.
const grayscaleEffect = z.object({
  type: z.literal('grayscale'),
  amount: z.number().min(0).max(1).optional()
    .describe('Mix: 1 = fully gray (default), 0.5 = half desaturated'),
}).strict().describe('Grayscale / "black and white" (the colloquial ask — see threshold for true 2-tone)');

const sepiaEffect = z.object({
  type: z.literal('sepia'),
  amount: z.number().min(0).max(1).optional()
    .describe('Mix: 1 = full sepia (default), lower for a subtle vintage warmth'),
}).strict().describe('Warm brown vintage photo tone');

const invertEffect = z.object({
  type: z.literal('invert'),
  amount: z.number().min(0).max(1).optional().describe('Mix; default 1 (full negative)'),
}).strict().describe('Invert colors (photo negative)');

const hueRotateEffect = z.object({
  type: z.literal('hue-rotate'),
  degrees: z.number().min(-360).max(360)
    .describe('Rotate every hue around the color wheel by this angle'),
}).strict().describe('Shift all hues (psychedelic color shift, quick recolors)');

const temperatureEffect = z.object({
  type: z.literal('temperature'),
  amount: z.number().min(-1).max(1)
    .describe('White balance: positive = warmer (amber), negative = cooler (blue); ±0.3 is already strong'),
  tint: z.number().min(-1).max(1).optional()
    .describe('Green–magenta axis: positive = magenta, negative = green'),
}).strict().describe('Color temperature / white balance correction');

const duotoneEffect = z.object({
  type: z.literal('duotone'),
  shadow: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Color the darkest tones map to'),
  highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Color the brightest tones map to'),
}).strict().describe('Two-color poster look: luminance mapped onto a shadow→highlight ramp');

const levelsEffect = z.object({
  type: z.literal('levels'),
  black: z.number().min(0).max(1).optional().describe('Input black point 0..1; default 0'),
  white: z.number().min(0).max(1).optional().describe('Input white point 0..1; default 1'),
  gamma: z.number().min(0.1).max(10).optional()
    .describe('Midtone gamma: >1 brightens mids, <1 darkens; default 1'),
}).strict().describe('Levels correction — fix washed-out or murky footage (black/white points + gamma)');

const vibranceEffect = z.object({
  type: z.literal('vibrance'),
  amount: z.number().min(-1).max(1)
    .describe('Saturation boost weighted toward muted pixels (flattering on skin); negative mutes'),
}).strict().describe('Vibrance — smarter saturation');

const posterizeEffect = z.object({
  type: z.literal('posterize'),
  levels: z.number().int().min(2).max(32).describe('Color levels per channel; 4–8 is the classic poster look'),
}).strict().describe('Quantize colors to N levels (poster / print look)');

const thresholdEffect = z.object({
  type: z.literal('threshold'),
  cutoff: z.number().min(0).max(1).optional().describe('Luma cutoff; default 0.5'),
}).strict().describe('True 2-tone black/white by luminance (stencil look) — NOT the everyday "black and white" ask (that is grayscale)');

const blurEffect = z.object({
  type: z.literal('blur'),
  radius: z.number().min(0.5).max(50).optional()
    .describe('Gaussian σ in pixels; default 8. 2–4 subtle, 10+ heavy'),
}).strict().describe('Gaussian blur');

const sharpenEffect = z.object({
  type: z.literal('sharpen'),
  amount: z.number().min(0).max(2).optional().describe('Unsharp-mask strength; default 1'),
}).strict().describe('Sharpen (unsharp mask)');

const pixelateEffect = z.object({
  type: z.literal('pixelate'),
  size: z.number().int().min(2).max(256).optional()
    .describe('Block size in pixels; omit for a sensible default (~2.5% of the smaller dimension)'),
}).strict().describe('Mosaic / pixelate the whole frame');

const grainEffect = z.object({
  type: z.literal('grain'),
  amount: z.number().min(0).max(1).optional().describe('Noise strength; default 0.3 (film-like)'),
}).strict().describe('Animated film grain');

const vignetteEffect = z.object({
  type: z.literal('vignette'),
  strength: z.number().min(0).max(1).optional().describe('Corner darkening; default 0.5'),
  size: z.number().min(0.05).max(1).optional()
    .describe('Fraction of the radius affected; default 0.5 (bigger = creeps further in)'),
}).strict().describe('Darkened corners (vignette)');

// Named looks [E7] — engine-owned recipes over the primitives (ir/looks.ts).
const lookEffect = z.object({
  type: z.literal('look'),
  name: z.enum(['vintage', 'noir', 'vhs', 'cinematic', 'vivid', 'dreamy', 'faded', 'summer', 'winter'])
    .describe("vintage = warm 70s film · noir = high-contrast B&W · vhs = worn tape · cinematic = graded film · vivid = punchy pop · dreamy = soft glow · faded = washed matte · summer = warm bright · winter = cool muted"),
  amount: z.number().min(0).max(1).optional()
    .describe('How strongly to apply the look; default 1 ("subtle"/"a touch of" ≈ 0.5)'),
}).strict().describe('A named style preset — use for STYLE asks ("70s film", "film noir", "VHS"); compose individual filters only when the user asks for specifics');

// Model-backed effects [E4]. v0.2: legal at the render top level only
// (normalize gates placement); per-clip/per-layer forms are stated return
// paths [U1, H1].
const upscaleEffect = z.object({
  type: z.literal('upscale'),
  scale: z.number().positive().max(8).optional()
    .describe('Delivered scale factor; default 2. Independent of the model — a bicubic post-pass bridges the network\'s native factor [U1]'),
  model: z.enum(['auto', 'fast', 'balanced', 'quality', 'ultra']).optional()
    .describe("Quality tier; default 'auto' (device/backend/input-size policy picks). Tiers map to networks in a planner-owned registry [U1a]"),
}).strict().describe('AI upscale (super-resolution). Video effect; render top level only in v0.2');

const denoiseEffect = z.object({
  type: z.literal('denoise'),
  model: z.enum(['auto', 'high', 'mid', 'low']).optional()
    .describe("Denoiser tier; default 'auto' (device capability picks). high/mid = DeepFilterNet3, low = RNNoise floor [H2]"),
}).strict().describe('AI audio denoise (remove background noise). Applies to the final mixed audio; render top level only [H1]');

const enhanceEffect = z.object({
  type: z.literal('enhance'),
}).strict().describe('AI voice enhancement (VoiceFixer): restores noisy, echoey, muffled or low-quality SPEECH — denoise + dereverb + bandwidth extension in one. Speech only (music underneath gets mangled); the output audio is mono. One-time ~224 MB model download, needs WebGPU. Replaces denoise (never both). Render top level only');

const levelEffect = z.object({
  type: z.literal('level'),
  target: z.number().min(-36).max(-6).optional()
    .describe('Target loudness in LUFS; default -16 (podcast). YouTube normalizes to -14'),
}).strict().describe('Adaptive audio leveling [H4]: evens out volume differences (quiet/loud speakers, mixed clips) toward a consistent loudness. Applies to the final mixed audio; render top level only');

export const effectSchema = z.union([
  cropAspect, cropRegion, resizeEffect, rotateEffect, flipEffect, padEffect,
  brightnessEffect, contrastEffect, saturationEffect,
  grayscaleEffect, sepiaEffect, invertEffect, hueRotateEffect, temperatureEffect,
  duotoneEffect, levelsEffect, vibranceEffect, posterizeEffect, thresholdEffect,
  blurEffect, sharpenEffect, pixelateEffect, grainEffect, vignetteEffect,
  lookEffect,
  upscaleEffect, denoiseEffect, enhanceEffect, levelEffect,
]).describe('A duration-preserving effect [T3]. Chain order is application order [E1]');
export type Effect = z.infer<typeof effectSchema>;

// ---------------------------------------------------------------------------
// Layers [C3–C5] — used inside compositions; overlays extend with a window.
// ---------------------------------------------------------------------------

const layerCommon = {
  source: refSchema,
  range: rangeSchema.optional(),
  at: timeScalarSchema.optional()
    .describe('Slot-time offset for a staggered entrance (e.g. lower-third at 2s) [A5]'),
  effects: z.array(effectSchema).optional(),
};

const videoLayer = z.object({
  type: z.literal('video').describe('Use the source\'s picture (its audio is muted unless audio:true)'),
  ...layerCommon,
  place: placeSchema.optional().describe('Required for non-base layers [G2]'),
  opacity: z.number().min(0).max(1).optional(),
  audio: z.boolean().optional().describe('Opt this layer\'s audio into the mix; default false for non-base [C5]'),
  volume: volumeSchema.optional(),
}).strict();

const imageLayer = z.object({
  type: z.literal('image'),
  ...layerCommon,
  place: placeSchema.optional().describe('Required for non-base layers [G2]'),
  opacity: z.number().min(0).max(1).optional(),
}).strict();

const audioLayer = z.object({
  type: z.literal('audio').describe('Use the source\'s audio only (legal on audio AND video assets) [C3]'),
  source: refSchema,
  range: rangeSchema.optional(),
  at: timeScalarSchema.optional(),
  volume: volumeSchema.optional(),
}).strict();

export const layerSchema = z.discriminatedUnion('type', [videoLayer, imageLayer, audioLayer])
  .describe('A composition layer. type declares the USAGE (projection), validated against the source\'s tracks [C3]');
export type Layer = z.infer<typeof layerSchema>;

// ---------------------------------------------------------------------------
// Timeline items [T1] — clip | composition | transition.
// ---------------------------------------------------------------------------

export const clipSchema = z.object({
  type: z.literal('clip'),
  source: refSchema,
  range: rangeSchema.optional(),
  speed: z.number().positive().optional().describe('Playback rate; timeline-side because it changes duration [T3]'),
  volume: volumeSchema.optional(),
  effects: z.array(effectSchema).optional(),
}).strict();
export type Clip = z.infer<typeof clipSchema>;

export const compositionSchema = z.object({
  type: z.literal('composition'),
  layers: z.array(layerSchema).min(1)
    .describe('Painter order: FIRST layer is the BOTTOM and the BASE (drives timing) [C1, C2]'),
  duration: timeScalarSchema.optional().describe('Override; default = base layer duration [C2]'),
  effects: z.array(effectSchema).optional().describe('Applied to the composed slot'),
}).strict();
export type Composition = z.infer<typeof compositionSchema>;

export const transitionSchema = z.object({
  type: z.literal('transition'),
  style: z.enum(['crossfade']).describe('v0.1 vocabulary [X4]'),
  duration: z.number().positive().describe('Overlap seconds; CONSUMES this much from each neighbor [X2]'),
}).strict();
export type Transition = z.infer<typeof transitionSchema>;

export const timelineItemSchema = z.discriminatedUnion('type', [clipSchema, compositionSchema, transitionSchema]);
export type TimelineItem = z.infer<typeof timelineItemSchema>;

// ---------------------------------------------------------------------------
// Overlays [O1–O4] — document-scoped layers with an OUTPUT-time window [A6].
// ---------------------------------------------------------------------------

const overlayWindow = {
  from: timeScalarSchema.optional().describe('Output-time window start; default start'),
  to: timeScalarSchema.optional().describe('Output-time window end'),
  duration: timeScalarSchema.optional().describe('Alternative to `to`'),
};

/** Whether the user's words actually contained the placement, or the model
 *  defaulted it. 'assumed' placements are resolved by the user dragging the
 *  overlay in the app before the plan runs; the widget flips this to 'user'. */
const placementSourceSchema = z.enum(['user', 'assumed'])
  .describe("'user' when the request states where the overlay goes (a corner, edge, position); 'assumed' when you chose a default. Never ask where — default top-right and mark 'assumed'");

const videoOverlay = z.object({
  type: z.literal('video'), source: refSchema, range: rangeSchema.optional(),
  ...overlayWindow,
  place: placeSchema.describe('Required on visual overlays [G2]'),
  placementSource: placementSourceSchema,
  opacity: z.number().min(0).max(1).optional(),
  audio: z.boolean().optional().describe('Opt the overlay video\'s audio into the mix; default false [O4]'),
  volume: volumeSchema.optional(),
}).strict();

const imageOverlay = z.object({
  type: z.literal('image'), source: refSchema,
  ...overlayWindow,
  place: placeSchema.describe('Required on visual overlays [G2]'),
  placementSource: placementSourceSchema,
  opacity: z.number().min(0).max(1).optional(),
}).strict();

const audioOverlay = z.object({
  type: z.literal('audio'), source: refSchema, range: rangeSchema.optional(),
  ...overlayWindow,
  volume: volumeSchema.optional(),
}).strict();

const captionsOverlay = z.object({
  type: z.literal('captions').describe('BURN the timed-text into pixels [O5] (soft/selectable subtitles are output.subtitles [D8])'),
  source: refSchema.describe('A timed-text (WebVTT) asset; cue times are OUTPUT-timeline times'),
  ...overlayWindow,
  style: z.enum(['shadow', 'outline', 'block']).optional()
    .describe("Visual style: 'shadow' (white + drop shadow, default), 'outline' (thick black outline), 'block' (highlight box behind the current word — needs inline word timestamps in the VTT)"),
  background: z.boolean().optional()
    .describe('Semi-transparent dark bar behind each caption line (readability on busy footage)'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
    .describe('Accent/highlight color; default #ffffff'),
  font: z.string().max(64).optional()
    .describe("Font family (built-ins like 'Helvetica' need no network; Google-Fonts names load on demand)"),
  size: spaceScalarSchema.optional()
    .describe("Text height; pixels or percent of canvas height. Default '7%'"),
  place: placeSchema.optional()
    .describe('Wrapping/placement box; default bottom-center, 80% width'),
}).strict();

export const overlaySchema = z.discriminatedUnion('type', [videoOverlay, imageOverlay, audioOverlay, captionsOverlay]);
export type Overlay = z.infer<typeof overlaySchema>;

// ---------------------------------------------------------------------------
// Output [D1–D5]
// ---------------------------------------------------------------------------

/** Deliverable filename STEM (no extension, no path). The host appends the
 *  extension implied by the container/format. */
const outputNameSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/)
  .describe("Output filename stem, NO extension: the source filename's stem plus what was done, e.g. 'my-file-with-subtitles', 'holiday-clip-upscaled'");

export const outputSchema = z.object({
  name: outputNameSchema.optional(),
  container: z.enum(['mp4', 'webm', 'mkv', 'mp3', 'wav', 'ogg', 'png', 'jpeg', 'gif'])
    .describe("Target format. 'png'/'jpeg' extract a SINGLE FRAME (see `at`) [D7]; 'gif' is animated, video-only [D9]"),
  at: timeScalarSchema.optional()
    .describe('Image outputs only: the OUTPUT-time instant to extract (composes with trims/effects/overlays); default start [D7]'),
  video: z.object({
    codec: z.enum(['auto', 'avc', 'hevc', 'vp9', 'av1']).optional()
      .describe("'auto' = copy if legal and untouched, else transcode to the container default [D1]"),
    quality: z.enum(['low', 'medium', 'high']).optional(),
    bitrate: z.number().positive().optional().describe('Bits per second; overrides quality'),
  }).strict().optional().describe('Omit for audio-only outputs [D4]'),
  audio: z.object({
    from: refSchema.optional().describe('REPLACES the timeline\'s audio wholesale (swap) [D2]'),
    codec: z.enum(['auto', 'aac', 'opus', 'pcm-s16', 'mp3']).optional(),
    bitrate: z.number().positive().optional(),
    sampleRate: z.number().int().min(8000).max(192000).optional()
      .describe('Resample the output audio to this rate in Hz (e.g. 44100, 48000); default keeps the source rate [D6]'),
  }).strict().optional().describe('Omit entirely = no audio track (mute) [D2]'),
  subtitles: z.object({
    from: refSchema.describe('timed-text asset (WebVTT) to mux as a soft subtitle track [D8]'),
    language: z.string().regex(/^[a-z]{3}$/).optional().describe("ISO 639-2/T three-letter code, e.g. 'eng', 'pol' (probe reports the same form)"),
  }).strict().optional().describe('Soft subtitles: a selectable track, NOT burned into pixels. Cue times are OUTPUT-timeline times [D8]'),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional()
    .describe("Solid fill behind everything (hex, e.g. '#00ff00'): what transparent or uncovered pixels show — e.g. a removebg cut-out on a solid color. Default: black for video, transparent for png"),
  resolution: z.object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .strict().optional().describe('Overrides the canvas rule [V1]'),
  fps: z.number().positive().optional().describe('CFR conformance ON REQUEST only; default preserves VFR [D5]'),
}).strict();
export type Output = z.infer<typeof outputSchema>;

// ---------------------------------------------------------------------------
// Operations & envelope [P1–P3, A1]
// ---------------------------------------------------------------------------

export const renderOpSchema = z.object({
  id: idSchema,
  op: z.literal('render'),
  timeline: z.array(timelineItemSchema).min(1),
  overlays: z.array(overlaySchema).optional(),
  effects: z.array(effectSchema).optional().describe('Applied to the composed output'),
  output: outputSchema,
}).strict();
export type RenderOp = z.infer<typeof renderOpSchema>;

export const assetDeclSchema = z.object({
  kind: z.enum(['video', 'audio', 'image', 'timed-text']),
  label: z.string().max(256).optional().describe('Human-facing name (filename); never identity [P1]'),
}).strict();
export type AssetDecl = z.infer<typeof assetDeclSchema>;

// ---------------------------------------------------------------------------
// Deriver operations [G1, R, L, B] — pipeline-tier ops producing artifacts
// (timed-text, image) that later operations reference by id [P2a].
// ---------------------------------------------------------------------------

const lang2 = z.string().regex(/^[a-z]{2}$/)
  .describe("ISO 639-1 two-letter code ('en', 'es', 'ja') — the vocabulary whisper and the translation models use natively");

export const transcribeOpSchema = z.object({
  id: idSchema,
  op: z.literal('transcribe'),
  source: refSchema.describe('A video or audio asset (or artifact) with an audio track'),
  language: lang2.optional().describe('Spoken language; omit for auto-detect'),
  model: z.enum(['tiny', 'base', 'small']).optional()
    .describe("Whisper size; default 'base' (balanced). All sizes are multilingual"),
  format: z.enum(['vtt', 'srt']).optional()
    .describe("Serialization when this artifact is the deliverable; default 'vtt' [G3]"),
  name: outputNameSchema.optional().describe('Only when this op is the deliverable: output filename stem, no extension'),
}).strict().describe('Speech → timed-text artifact with word timestamps [R1]. Compose via output.subtitles.from (soft) or a captions overlay (burn)');
export type TranscribeOp = z.infer<typeof transcribeOpSchema>;

export const translateOpSchema = z.object({
  id: idSchema,
  op: z.literal('translate'),
  source: refSchema.describe('A timed-text asset OR a transcribe/translate artifact [L1]'),
  to: lang2.describe('Target language'),
  from: lang2.optional().describe('Source language; omit for auto-detect'),
  format: z.enum(['vtt', 'srt']).optional()
    .describe("Serialization when this artifact is the deliverable; default 'vtt' [G3]"),
  name: outputNameSchema.optional().describe('Only when this op is the deliverable: output filename stem, no extension'),
}).strict().describe('Translate cue text preserving cue timings [L2]. Exotic pairs pivot through English [L3]');
export type TranslateOp = z.infer<typeof translateOpSchema>;

export const removebgOpSchema = z.object({
  id: idSchema,
  op: z.literal('removebg'),
  source: refSchema.describe('An image asset (or image artifact)'),
  format: z.enum(['png', 'jpeg']).optional()
    .describe("Serialization when this artifact is the deliverable; default 'png' (jpeg composites over white) [G3]"),
  model: z.enum(['quality', 'fast']).optional()
    .describe("Omit for the default (any subject). 'fast': small person-only model — only when the user asks for speed"),
  name: outputNameSchema.optional().describe('Only when this op is the deliverable: output filename stem, no extension'),
}).strict().describe('Remove image background → RGBA image artifact (same dimensions) [B1]. Referenceable as an overlay/layer source [B3]');
export type RemovebgOp = z.infer<typeof removebgOpSchema>;

export const transformImageOpSchema = z.object({
  id: idSchema,
  op: z.literal('transformImage'),
  source: refSchema.describe('An image asset (or image artifact, e.g. a removebg output)'),
  effects: z.array(effectSchema).min(1)
    .describe('Effect chain applied in order [E1] — the same vocabulary as render effects (filters, looks, crop, resize…)'),
  format: z.enum(['png', 'jpeg']).optional()
    .describe("Serialization when this artifact is the deliverable; default 'png' (jpeg composites over white) [G3]"),
  name: outputNameSchema.optional().describe('Only when this op is the deliverable: output filename stem, no extension'),
}).strict().describe('Apply effects to an image → image artifact. Referenceable as an overlay/layer source — the shape for "filter this image, THEN use it in a video" (e.g. grayscale a logo and overlay it as a watermark)');
export type TransformImageOp = z.infer<typeof transformImageOpSchema>;

export const qrcodeOpSchema = z.object({
  id: idSchema,
  op: z.literal('qrcode'),
  text: z.string().min(1).max(2000)
    .describe('The exact text the code will encode — usually a URL, taken verbatim from the user (never invent or "fix" it)'),
  ec: z.enum(['low', 'medium', 'quartile', 'high']).optional()
    .describe("Error-correction level; default 'medium'. 'high' stays scannable when partially covered but makes a denser code"),
  size: z.number().int().min(64).max(4096).optional()
    .describe('Image side in pixels (codes are square); default 1024'),
  format: z.enum(['png', 'jpeg']).optional()
    .describe("Serialization when this artifact is the deliverable; default 'png'"),
  name: outputNameSchema.optional().describe('Only when this op is the deliverable: output filename stem, no extension'),
}).strict().describe('Generate a QR code → square image artifact. The ONLY operation with no source — it needs no input asset. Referenceable as an overlay/layer source (e.g. put a QR code linking somewhere in the corner of a video)');
export type QrcodeOp = z.infer<typeof qrcodeOpSchema>;

export const operationSchema = z.discriminatedUnion('op', [
  renderOpSchema, transcribeOpSchema, translateOpSchema, removebgOpSchema, transformImageOpSchema,
  qrcodeOpSchema,
]);
export type Operation = z.infer<typeof operationSchema>;
export type DeriverOp = TranscribeOp | TranslateOp | RemovebgOp | TransformImageOp | QrcodeOp;

export const irDocumentSchema = z.object({
  version: z.literal(IR_VERSION),
  assets: z.record(idSchema, assetDeclSchema),
  operations: z.array(operationSchema).min(1)
    .describe('The operation DAG [G1]: sources may name assets or earlier operations\' outputs. The LAST operation\'s output is the deliverable [G2]'),
}).strict();
export type IrDocument = z.infer<typeof irDocumentSchema>;

/** JSON Schema for schema-enforced emission (structured outputs / responseConstraint). */
export function irJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(irDocumentSchema) as Record<string, unknown>;
}
