/**
 * lower() — normalized document + facts → CompiledPlan [§13].
 * Deterministic chain: resolve symbols (scalars.ts) → geometry chains →
 * timeline positions (consume-semantics transitions) → unified boundary sweep
 * → per-span composites/bindings/ramps → plan.
 *
 * v0.1 notes: unified spans (audio boundaries split video spans too — the
 * per-lane sweep is a later executor refinement). Per-track strategy is
 * negotiated [D1]: 'copy' when a track reaches the output untouched and its
 * codec is container-legal; 'reencode' otherwise.
 */

import type {
  CompiledPlan, CompiledPipeline, FilterStep, Geometry, Layer as PlanLayer, ParamRamp, Span, SlotBinding,
  Sec, VideoLanePlan, AudioLanePlan, OutputDecl, CaptionSlotSpec, PipelineStep,
  VideoKernelDecl, AudioKernelDecl,
} from '../schema';
import type { Clip, Composition, Effect, IrDocument, Overlay, Place, RenderOp, Layer as IrLayer } from './document';
import { err, type IrError } from './errors';
import { opReferences } from './normalize';
import { imageFacts, timedTextFacts, type AssetFacts, type FactsTable } from './facts';
import { expandLooks } from './looks';
import { resolveRange, resolveSpace, resolveTime, resolveVolume } from './scalars';
import { ANCHOR, cropBox, placeBox } from './place';
import { canCopyCodec, type ContainerId } from '../codec-tables';
import type { CopyTrackDecl } from '../schema';

const EPS = 1e-6;
type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 0, 1, 0];
const mul = (m2: Mat, m1: Mat): Mat => [
  m2[0] * m1[0] + m2[1] * m1[3], m2[0] * m1[1] + m2[1] * m1[4], m2[0] * m1[2] + m2[1] * m1[5] + m2[2],
  m2[3] * m1[0] + m2[4] * m1[3], m2[3] * m1[1] + m2[4] * m1[4], m2[3] * m1[2] + m2[4] * m1[5] + m2[5],
];
const translate = (x: number, y: number): Mat => [1, 0, x, 0, 1, y];
const scale = (sx: number, sy: number): Mat => [sx, 0, 0, 0, sy, 0];
interface Rect { x: number; y: number; w: number; h: number }

// ---------------------------------------------------------------------------
// Effect chain folding — source geometry → {srcRect, natural geom, F}
// F maps source coords → natural coords (axis-preserving ops only in v0.1).
// ---------------------------------------------------------------------------

/** Straight-color affine transform: rgb' = m·rgb + o (row-major 3x3). All
 * lighting filters are affine, so they fuse into one — and they commute
 * exactly with the geometry ops (linear resampling of affinely-transformed
 * colors = affine transform of resampled colors), so interleaving is free. */
interface ColorXf { m: number[]; o: [number, number, number] }

const colorMul = (b: ColorXf, a: ColorXf): ColorXf => {
  // apply a first, then b: m = b.m·a.m ; o = b.m·a.o + b.o
  const m = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = b.m[r * 3]! * a.m[c]! + b.m[r * 3 + 1]! * a.m[3 + c]! + b.m[r * 3 + 2]! * a.m[6 + c]!;
    }
  }
  const o = [0, 1, 2].map((r) =>
    b.m[r * 3]! * a.o[0] + b.m[r * 3 + 1]! * a.o[1] + b.m[r * 3 + 2]! * a.o[2] + b.o[r]!) as [number, number, number];
  return { m, o };
};

// Rec.709 luma weights (SVG/CSS saturate matrix)
const LUMA = [0.2126, 0.7152, 0.0722] as const;
const satMatrix = (s: number): number[] =>
  [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => LUMA[c]! * (1 - s) + (r === c ? s : 0)));
const scaleXf = (a: number, o = 0): ColorXf => ({ m: [a, 0, 0, 0, a, 0, 0, 0, a], o: [o, o, o] });
// CSS sepia() at amount 1; partial amounts lerp toward identity (per spec)
const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131] as const;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;
const hex01 = (h: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

const colorForEffect = (fx: Effect): ColorXf | null => {
  switch (fx.type) {
    case 'brightness': return scaleXf(fx.amount);
    case 'contrast': return scaleXf(fx.amount, 0.5 * (1 - fx.amount));
    case 'saturation': return { m: satMatrix(fx.amount), o: [0, 0, 0] };
    case 'grayscale': return { m: satMatrix(1 - (fx.amount ?? 1)), o: [0, 0, 0] };
    case 'sepia': {
      const a = fx.amount ?? 1;
      return { m: SEPIA.map((v, i) => IDENT[i]! + (v - IDENT[i]!) * a), o: [0, 0, 0] };
    }
    case 'invert': {
      const a = fx.amount ?? 1;
      return { m: scaleXf(1 - 2 * a).m, o: [a, a, a] };
    }
    case 'hue-rotate': {
      // SVG/CSS hueRotate matrix
      const rad = (fx.degrees * Math.PI) / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      return {
        m: [
          0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
          0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
          0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
        ],
        o: [0, 0, 0],
      };
    }
    case 'temperature': {
      const t = fx.amount;
      const g = 1 - 0.15 * (fx.tint ?? 0); // +tint = magenta = less green
      return { m: [1 + 0.2 * t, 0, 0, 0, g, 0, 0, 0, 1 - 0.2 * t], o: [0, 0, 0] };
    }
    case 'duotone': {
      const S = hex01(fx.shadow), H = hex01(fx.highlight);
      // s' = S + luma·(H − S): rank-1 matrix over the luma weights + offset
      const m = [0, 1, 2].flatMap((r) => LUMA.map((w) => (H[r]! - S[r]!) * w));
      return { m, o: S };
    }
    case 'levels': {
      // affine only without gamma; the gamma form is a pass step
      const gamma = fx.gamma ?? 1;
      if (Math.abs(gamma - 1) > 1e-6) return null;
      const b = fx.black ?? 0, w = fx.white ?? 1;
      const k = 1 / Math.max(w - b, 1e-4);
      return scaleXf(k, -b * k);
    }
    default: return null;
  }
};

/** Non-affine filter effects → resolved FilterStep (docs/filters-gpu-plan.md
 * §3). `geom` is the chain geometry AT this step — pixelate's default block
 * size is data-dependent. */
const filterStepFor = (fx: Effect, geom: Geometry): FilterStep | null => {
  switch (fx.type) {
    case 'levels':
      return { op: 'levels', inBlack: fx.black ?? 0, inWhite: fx.white ?? 1, gamma: fx.gamma ?? 1 };
    case 'threshold': return { op: 'threshold', cutoff: fx.cutoff ?? 0.5 };
    case 'posterize': return { op: 'posterize', levels: fx.levels };
    case 'vibrance': return { op: 'vibrance', amount: fx.amount };
    case 'blur': return { op: 'blur', radius: Math.min(fx.radius ?? 8, 50) };
    case 'sharpen': return { op: 'sharpen', amount: fx.amount ?? 1, radius: 2 };
    case 'pixelate':
      return { op: 'pixelate', size: fx.size ?? Math.max(8, Math.round(Math.min(geom.w, geom.h) / 40)) };
    case 'grain': return { op: 'grain', amount: fx.amount ?? 0.3 };
    case 'vignette': return { op: 'vignette', strength: fx.strength ?? 0.5, size: fx.size ?? 0.5 };
    default: return null;
  }
};

/** `fill`: the last explicit pad color in the chain — a BASE chain's fill
 * becomes its span's canvas background (the bars are uncovered canvas). */
interface Chain { srcRect: Rect; geom: Geometry; F: Mat; color?: ColorXf; filters?: FilterStep[]; fill?: string }

function foldEffects(g0: Geometry, effects: Effect[] | undefined, path: string, errors: IrError[]): Chain {
  let c: Chain = { srcRect: { x: 0, y: 0, w: g0.w, h: g0.h }, geom: { ...g0 }, F: I };
  /** Color/filter work in AUTHORED order — split into Layer.color vs filter
   * passes only once the whole chain is known (see the tail of this fn). */
  const pipe: ({ cx: ColorXf } | { fs: FilterStep })[] = [];
  for (const fx of expandLooks(effects ?? [])) {
    const cx = colorForEffect(fx);
    if (cx) {
      pipe.push({ cx });
      continue;
    }
    const fs = filterStepFor(fx, c.geom);
    if (fs) {
      pipe.push({ fs });
      continue;
    }
    if (fx.type === 'crop') {
      // region math lives in ./place (shared with the app's crop widget)
      const region: Rect = cropBox(fx, c.geom);
      if (region.w <= 0 || region.h <= 0 || region.x < -EPS || region.y < -EPS
        || region.x + region.w > c.geom.w + EPS || region.y + region.h > c.geom.h + EPS) {
        errors.push(err('range-invalid', path, `crop region exceeds current geometry ${c.geom.w}x${c.geom.h}`));
        continue;
      }
      // map region back to source space (F is axis-preserving & invertible)
      const inv = invertAxisAligned(c.F);
      const s0 = apply(inv, region.x, region.y);
      const s1 = apply(inv, region.x + region.w, region.y + region.h);
      c = {
        ...c,
        srcRect: rectFrom(s0, s1),
        geom: { w: region.w, h: region.h },
        F: mul(translate(-region.x, -region.y), c.F),
      };
    } else if (fx.type === 'resize') {
      let w = fx.width !== undefined ? resolveSpace(fx.width, c.geom.w) : undefined;
      let h = fx.height !== undefined ? resolveSpace(fx.height, c.geom.h) : undefined;
      if (w === undefined && h === undefined) continue;
      if (w === undefined) w = h! * (c.geom.w / c.geom.h);
      if (h === undefined) h = w * (c.geom.h / c.geom.w);
      c = { ...c, geom: { w, h }, F: mul(scale(w / c.geom.w, h / c.geom.h), c.F) };
    } else if (fx.type === 'flip') {
      c = {
        ...c,
        F: fx.axis === 'horizontal'
          ? mul([-1, 0, c.geom.w, 0, 1, 0], c.F)
          : mul([1, 0, 0, 0, -1, c.geom.h], c.F),
      };
    } else if (fx.type === 'rotate') {
      const turns = fx.degrees / 90;
      for (let t = 0; t < turns; t++) {
        c = { ...c, geom: { w: c.geom.h, h: c.geom.w }, F: mul([0, -1, c.geom.h, 1, 0, 0], c.F) };
      }
    } else if (fx.type === 'pad') {
      const [aw, ah] = fx.aspect.split(':').map(Number) as [number, number];
      const a = aw / ah;
      const cur = c.geom.w / c.geom.h;
      const padded: Geometry = cur < a
        ? { w: c.geom.h * a, h: c.geom.h }
        : { w: c.geom.w, h: c.geom.w / a };
      c = {
        ...c, geom: padded,
        F: mul(translate((padded.w - c.geom.w) / 2, (padded.h - c.geom.h) / 2), c.F),
        ...(fx.color ? { fill: fx.color } : {}),
      };
    }
  }
  // Split the color/filter pipe. All-affine chains fuse into ONE Layer.color
  // (zero passes — the common lighting case). The moment any pass step is
  // present, EVERYTHING runs in the filter chain in authored order — affine
  // runs become colorMatrix steps (consecutive ones fused; pass 0's
  // extraction fuses the leading run for free). Fusing the affine prefix into
  // Layer.color instead would apply it AFTER the rig, which only commutes for
  // linear spatial ops — not for grain/vignette/nonlinear pointwise.
  if (pipe.length) {
    if (pipe.every((p) => 'cx' in p)) {
      let acc: ColorXf | undefined;
      for (const p of pipe as { cx: ColorXf }[]) acc = acc ? colorMul(p.cx, acc) : p.cx;
      c = { ...c, ...(acc ? { color: acc } : {}) };
    } else {
      type Mat9 = Extract<FilterStep, { op: 'colorMatrix' }>['matrix'];
      const filters: FilterStep[] = [];
      for (const p of pipe) {
        if ('fs' in p) { filters.push(p.fs); continue; }
        const last = filters[filters.length - 1];
        if (last?.op === 'colorMatrix') {
          const merged = colorMul(p.cx, { m: [...last.matrix], o: [...last.offset] });
          filters[filters.length - 1] = { op: 'colorMatrix', matrix: merged.m.map(round6) as Mat9, offset: merged.o.map(round6) as [number, number, number] };
        } else {
          filters.push({ op: 'colorMatrix', matrix: p.cx.m.map(round6) as Mat9, offset: p.cx.o.map(round6) as [number, number, number] });
        }
      }
      c = { ...c, filters };
    }
  }
  return c;
}

const apply = (m: Mat, x: number, y: number): [number, number] =>
  [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
const rectFrom = (a: [number, number], b: [number, number]): Rect => ({
  x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
  w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]),
});
function invertAxisAligned(m: Mat): Mat {
  // supports scale/flip/quarter-turn/translate compositions (one of a,b is 0)
  const [a, b, c, d, e, f] = m;
  if (Math.abs(b) < EPS && Math.abs(d) < EPS) {
    return [1 / a, 0, -c / a, 0, 1 / e, -f / e];
  }
  // pure axis swap: x' = b*y + c ; y' = d*x + f
  return [0, 1 / d, -f / d, 1 / b, 0, -c / b];
}

/** Layer transform for the composite: srcRect-local → canvas box. */
function layerTransform(c: Chain, box: Rect): Mat {
  const toBox = mul(translate(box.x, box.y), scale(box.w / c.geom.w, box.h / c.geom.h));
  return mul(toBox, mul(c.F, translate(c.srcRect.x, c.srcRect.y)));
}

// ---------------------------------------------------------------------------
// Resolved model
// ---------------------------------------------------------------------------

interface VisualContrib {
  asset: string;
  isImage: boolean;
  chain: Chain;
  box: Rect;              // resolved placement on canvas
  opacity: number;
  outStart: Sec;          // output time this contributor starts playing
  srcStart: Sec;          // source time at outStart (0 for images)
  activeFrom: Sec;        // output time it becomes visible (>= outStart for `at`)
  activeTo: Sec;
  ramp?: ParamRamp;       // transition fade-in
  rate?: number;          // playback speed (source secs per output sec); default 1
  captions?: CaptionSlotSpec;  // burn-in caption contributor [O5]
  isBase?: boolean;       // a timeline slot's base — its chain.fill paints the span background
}
interface AudioContrib {
  asset: string;
  gain: number;
  outStart: Sec;
  srcStart: Sec;
  activeFrom: Sec;
  activeTo: Sec;
  fadeOut?: [Sec, Sec];   // transition gain ramp 1→0
  fadeIn?: [Sec, Sec];    // 0→1
  rate?: number;          // playback speed; default 1
}

const factsOf = (facts: FactsTable, id: string): AssetFacts | undefined => facts[id.split('.')[0]!];

// ---------------------------------------------------------------------------

/**
 * lower() — the pipeline walk [G1]: operations in topological order; deriver
 * steps synthesize artifact facts (transcribe/translate → timed-text,
 * removebg → image with the source's dimensions) so later operations resolve
 * artifact references exactly like assets. `plan` is populated when the
 * deliverable (last authored op [G2]) is a render — the single-render
 * back-compat surface every existing caller uses.
 */
export function lower(
  doc: IrDocument,
  facts: FactsTable,
  topoOrder?: number[],
): { pipeline: CompiledPipeline | null; plan: CompiledPlan | null; errors: IrError[] } {
  const errors: IrError[] = [];
  const order = topoOrder ?? doc.operations.map((_, i) => i);
  const steps: PipelineStep[] = [];
  const workingFacts: FactsTable = { ...facts };
  const deliverId = doc.operations[doc.operations.length - 1]!.id;
  let deliverPlan: CompiledPlan | null = null;

  for (const oi of order) {
    const op = doc.operations[oi]!;
    const opPath = `operations[${oi}]`;

    if (op.op === 'render') {
      const r = lowerRender(op, oi, workingFacts);
      errors.push(...r.errors);
      if (!r.plan) continue;
      steps.push({ kind: 'render', id: op.id, plan: r.plan });
      if (op.id === deliverId) deliverPlan = r.plan;
      continue;
    }

    if (op.op === 'qrcode') {
      // pure generator [Q1]: no source, geometry known up front — the artifact
      // is a size×size opaque image any later op references like an asset
      const size = op.size ?? 1024;
      workingFacts[op.id] = imageFacts(size, size);
      steps.push({
        kind: 'qr', id: op.id,
        params: { text: op.text, ec: op.ec ?? 'medium', size },
        format: op.format ?? 'png',
      });
      continue;
    }

    const sf = workingFacts[op.source.split('.')[0]!];
    if (!sf) { errors.push(err('unknown-reference', `${opPath}.source`, `no facts for '${op.source}'`)); continue; }

    if (op.op === 'transcribe') {
      if (!sf.audio && sf.kind !== 'audio' && sf.kind !== 'video') {
        errors.push(err('usage-unavailable', `${opPath}.source`, `'${op.source}' is ${sf.kind} — transcribe needs audio`));
        continue;
      }
      if (sf.kind === 'video' && !sf.audio) {
        errors.push(err('usage-unavailable', `${opPath}.source`, `'${op.source}' has no audio track to transcribe`));
        continue;
      }
      workingFacts[op.id] = timedTextFacts();
      steps.push({
        kind: 'transcribe', id: op.id, source: op.source,
        params: { model: op.model ?? 'base', ...(op.language ? { language: op.language } : {}) },
        format: op.format ?? 'vtt',
      });
    } else if (op.op === 'translate') {
      if (sf.kind !== 'timed-text') {
        errors.push(err('usage-unavailable', `${opPath}.source`, `'${op.source}' is ${sf.kind}, not timed-text [L1]`));
        continue;
      }
      workingFacts[op.id] = timedTextFacts();
      steps.push({
        kind: 'translate', id: op.id, source: op.source,
        params: { to: op.to, ...(op.from ? { from: op.from } : {}) },
        format: op.format ?? 'vtt',
      });
    } else if (op.op === 'removebg') {
      if (sf.kind !== 'image') {
        errors.push(err('usage-unavailable', `${opPath}.source`, `'${op.source}' is ${sf.kind}, not an image [B1]`));
        continue;
      }
      // removebg preserves dimensions [B1] — the artifact's geometry is known
      workingFacts[op.id] = imageFacts(sf.image!.width, sf.image!.height);
      // the tier reaches the host's deriver as a param; omitted = the host default
      steps.push({ kind: 'removebg', id: op.id, source: op.source, params: op.model ? { model: op.model } : {}, format: op.format ?? 'png' });
    } else {
      // transformImage IS a one-clip still render of the source [D7a] — lower
      // through lowerRender so effect folding, geometry, and validation are
      // the shipped image-as-base path, not a parallel one.
      if (sf.kind !== 'image') {
        errors.push(err('usage-unavailable', `${opPath}.source`, `'${op.source}' is ${sf.kind}, not an image`));
        continue;
      }
      // kernels are video/audio-lane [U1, H1] — a clip chain would silently
      // drop them, so refuse honestly here
      const kernelFx = op.effects.find((f) => f.type === 'upscale' || f.type === 'denoise' || f.type === 'level');
      if (kernelFx) {
        errors.push(err('usage-unavailable', `${opPath}.effects`, `'${kernelFx.type}' is not available in transformImage`));
        continue;
      }
      const fmt = op.format ?? 'png';
      const synth: RenderOp = {
        id: op.id, op: 'render',
        timeline: [{ type: 'clip', source: op.source, effects: op.effects }],
        // intermediates stay png — alpha must survive downstream compositing;
        // the authored format only matters at the delivery edge [G3].
        // `video: {}` is what normalize injects for image outputs (the synth
        // op never passes through normalize)
        output: { container: op.id === deliverId ? fmt : 'png', video: {}, ...(op.name ? { name: op.name } : {}) },
      };
      const r = lowerRender(synth, oi, workingFacts);
      // errors speak the authored shape: the synthetic clip's chain is op.effects
      errors.push(...r.errors.map((e) => ({
        ...e,
        path: e.path
          .replace(`${opPath}.timeline[0].effects`, `${opPath}.effects`)
          .replace(`${opPath}.timeline[0]`, `${opPath}.source`),
      })));
      if (!r.plan) continue;
      // effects may change geometry (crop/resize) — dims come from the plan
      workingFacts[op.id] = imageFacts(r.plan.canvas.w, r.plan.canvas.h);
      steps.push({ kind: 'transformImage', id: op.id, source: op.source, plan: r.plan, format: fmt });
    }
  }

  if (errors.length) return { pipeline: null, plan: null, errors };
  // [G2 amendment] every sink op delivers; authored order. (An op referenced
  // by any other op is intermediate — its output feeds the graph instead.)
  const consumed = new Set<string>();
  for (const op of doc.operations) for (const ref of opReferences(op)) consumed.add(ref.split('.')[0]!);
  const stepIds = new Set(steps.map((s) => s.id));
  const deliverables = doc.operations
    .filter((op) => !consumed.has(op.id) && stepIds.has(op.id))
    .map((op) => op.id);
  if (!deliverables.includes(deliverId)) deliverables.push(deliverId);
  return { pipeline: { steps, deliver: deliverId, deliverables }, plan: deliverPlan, errors };
}

function lowerRender(op: RenderOp, oi: number, facts: FactsTable): { plan: CompiledPlan | null; errors: IrError[] } {
  const errors: IrError[] = [];
  const opPath = `operations[${oi}]`;

  /** Single-frame output [D7] — the only render an image BASE can feed
   * (photo in → photo out; video-from-a-still needs a frame ticker, parked). */
  const stillOutput = op.output.container === 'png' || op.output.container === 'jpeg';
  /** Image outputs have no encoder — exact dims, no even-dimension rounding. */
  const evenOut = (n: number) => stillOutput ? Math.max(1, Math.round(n)) : even(n);

  // Model-backed kernel effects [U1, H1] are extracted before geometry
  // folding — they are whole-output kernels, not chain entries. normalize
  // guarantees at most one of each, top-level only.
  const upscaleFx = op.effects?.find((f) => f.type === 'upscale');
  const denoiseFx = op.effects?.find((f) => f.type === 'denoise');
  const levelFx = op.effects?.find((f) => f.type === 'level');
  const geomFx = op.effects?.filter((f) => f.type !== 'upscale' && f.type !== 'denoise' && f.type !== 'level');

  // ---- slot durations & transitions (consume semantics [X2]) -------------
  interface SlotInfo {
    item: Clip | Composition;
    duration: number;        // OUTPUT duration (source range / speed)
    speed: number;           // clip playback rate [T3]; 1 for compositions
    pos: Sec;                // output start
    baseRange: { start: number; end: number } | null; // base video/audio source range
    baseAsset: string;
    path: string;
  }
  const slots: SlotInfo[] = [];
  const transitions: { afterSlot: number; duration: number }[] = [];

  /** [D7b] video from a still: the image has no clock, so its slot duration
   * comes from (in order) an explicit composition.duration, else the wired
   * soundtrack's length — output.audio.from, audio overlays, or the
   * composition's own audio layers. Audio-derived durations require the
   * image to be the SOLE timeline item (shared audio would double-count). */
  const soleVisual = op.timeline.filter((t) => t.type !== 'transition').length === 1;
  const stillBaseDuration = (item: Clip | Composition, path: string): number | null => {
    if (item.type === 'composition' && item.duration !== undefined) {
      const d = resolveTime(item.duration, 0); // no total to resolve % against
      if (d > EPS) return d;
      errors.push(err('range-invalid', `${path}.duration`, 'a still base needs an absolute duration (seconds), not a percentage'));
      return null;
    }
    let best = 0;
    if (soleVisual) {
      const swap = op.output.audio?.from;
      if (swap) {
        const af = factsOf(facts, swap);
        if (af?.audio && Number.isFinite(af.duration)) best = af.duration;
      }
      for (const ov of op.overlays ?? []) {
        if (ov.type !== 'audio') continue;
        const af = factsOf(facts, ov.source);
        if (!af?.audio || !Number.isFinite(af.duration)) continue;
        const r = resolveRange(ov.range, af.duration);
        const from = typeof ov.from === 'number' ? ov.from : 0;
        best = Math.max(best, from + (r.end - r.start));
      }
      if (item.type === 'composition') {
        for (const l of item.layers) {
          if (l.type !== 'audio') continue;
          const af = factsOf(facts, l.source);
          if (!af?.audio || !Number.isFinite(af.duration)) continue;
          const r = resolveRange(l.range, af.duration);
          const at = typeof l.at === 'number' ? l.at : 0;
          best = Math.max(best, at + (r.end - r.start));
        }
      }
    }
    if (best > EPS) return best;
    errors.push(err('usage-unavailable', path, soleVisual
      ? 'a video from a still image needs a duration: wire audio (its length drives the video) or give a composition an explicit duration'
      : 'a still image alongside other timeline items needs an explicit composition.duration'));
    return null;
  };

  op.timeline.forEach((item, ti) => {
    const path = `${opPath}.timeline[${ti}]`;
    if (item.type === 'transition') {
      transitions.push({ afterSlot: slots.length - 1, duration: item.duration });
      return;
    }
    const baseSource = item.type === 'clip' ? item.source : item.layers[0]!.source;
    const f = factsOf(facts, baseSource);
    if (!f) { errors.push(err('unknown-reference', path, `no facts for '${baseSource}'`)); return; }
    if (f.kind === 'image') {
      if (item.type === 'clip' ? (item.range || item.speed !== undefined) : item.layers[0]!.range) {
        errors.push(err('field-not-applicable', path, 'range/speed do not apply to an image base'));
        return;
      }
      if (stillOutput) {
        // [D7a] photo in → photo out: nominal 1 s duration — the still path
        // renders one instant, nothing streams
        slots.push({ item, duration: 1, speed: 1, pos: 0, baseRange: null, baseAsset: baseSource, path });
        return;
      }
      if (op.output.container === 'mp3' || op.output.container === 'wav' || op.output.container === 'ogg') {
        errors.push(err('usage-unavailable', path, 'an image base cannot feed an audio-only output'));
        return;
      }
      // [D7b] video from a still: the executor's frame ticker renders the
      // composite at CFR — but there is no primary decode clock, so video
      // sources cannot ride on top (image/caption/audio layers can)
      if (item.type === 'composition' && item.layers.some((l, li) => li > 0 && l.type === 'video')) {
        errors.push(err('unsupported-in-v01', path,
          'video layers over a still base are not supported yet; use image/caption/audio layers'));
        return;
      }
      if (op.overlays?.some((o) => o.type === 'video')) {
        errors.push(err('unsupported-in-v01', `${opPath}.overlays`,
          'video overlays over a still base are not supported yet; use image/caption/audio overlays'));
        return;
      }
      const D = stillBaseDuration(item, path);
      if (D === null) return;
      slots.push({ item, duration: round6(D), speed: 1, pos: 0, baseRange: null, baseAsset: baseSource, path });
      return;
    }
    if (f.kind === 'timed-text') { errors.push(err('usage-unavailable', path, 'timed-text assets wire into output.subtitles [D8], not the timeline')); return; }
    const baseRange = resolveRange(item.type === 'clip' ? item.range : item.layers[0]!.range, f.duration);
    if (baseRange.end - baseRange.start <= EPS || baseRange.start < -EPS || baseRange.end > f.duration + EPS) {
      errors.push(err('range-invalid', `${path}.range`, `resolved range [${baseRange.start}, ${baseRange.end}) invalid for duration ${f.duration}`));
      return;
    }
    const speed = item.type === 'clip' ? (item.speed ?? 1) : 1;
    let duration = (baseRange.end - baseRange.start) / speed;
    if (item.type === 'composition' && item.duration !== undefined) {
      const d = resolveTime(item.duration, duration);
      if (d > duration + EPS) { errors.push(err('unsupported-in-v01', `${path}.duration`, 'composition.duration longer than base (hold-last-frame) not in v0.1')); }
      else duration = d;
    }
    slots.push({ item, duration, speed, pos: 0, baseRange, baseAsset: baseSource, path });
  });
  if (errors.length) return { plan: null, errors };

  // positions with consume
  let cursor = 0;
  const overlapAfter: number[] = slots.map(() => 0);
  for (const t of transitions) {
    if (t.afterSlot >= 0) overlapAfter[t.afterSlot] = t.duration;
  }
  slots.forEach((s, i) => {
    s.pos = cursor;
    cursor += s.duration - (overlapAfter[i] ?? 0);
  });
  const outputDuration = slots.length ? slots[slots.length - 1]!.pos + slots[slots.length - 1]!.duration : 0;

  transitions.forEach((t) => {
    const a = slots[t.afterSlot]; const b = slots[t.afterSlot + 1];
    if (!a || !b) return;
    if (t.duration > a.duration + EPS || t.duration > b.duration + EPS) {
      errors.push(err('transition-too-long', `${opPath}.timeline`, `transition ${t.duration}s exceeds a neighbor's duration`));
    }
  });

  // ---- canvas [V1] --------------------------------------------------------
  const baseChains = new Map<number, Chain>();
  slots.forEach((s, i) => {
    const f = factsOf(facts, s.baseAsset)!;
    const g0 = f.video ? { w: f.video.width, h: f.video.height }
      : f.image ? { w: f.image.width, h: f.image.height } : null;
    if (!g0) return;
    const effects = s.item.type === 'clip' ? s.item.effects
      : [...(s.item.layers[0]!.type !== 'audio' ? s.item.layers[0]!.effects ?? [] : []), ...(s.item.effects ?? [])];
    baseChains.set(i, foldEffects(g0, effects, s.path, errors));
  });
  // With an upscale kernel, output.resolution names the KERNEL's target [U2]
  // — the composite canvas comes from the natural vote either way.
  let canvas: Geometry | null = null;
  if (op.output.resolution && !upscaleFx) canvas = { w: op.output.resolution.width, h: op.output.resolution.height };
  else {
    for (const c of baseChains.values()) {
      if (!canvas || c.geom.w * c.geom.h > canvas.w * canvas.h) canvas = { w: evenOut(c.geom.w), h: evenOut(c.geom.h) };
    }
  }
  const hasVideoContent = baseChains.size > 0;

  // top-level effects [E1]: applied to the composed output — fold from the
  // composed canvas; the chain adjusts the final canvas AND premultiplies
  // every span layer's transform (cropped spill is clipped by the canvas).
  let outputChain: Chain | null = null;
  let composedCanvas: Geometry | null = canvas;
  if (geomFx?.length) {
    if (!canvas || !hasVideoContent) {
      errors.push(err('field-not-applicable', `${opPath}.effects`, 'top-level effects require video content'));
    } else {
      outputChain = foldEffects(canvas, geomFx, `${opPath}.effects`, errors);
      composedCanvas = canvas;
      canvas = { w: evenOut(outputChain.geom.w), h: evenOut(outputChain.geom.h) };
    }
  }
  // [D2 amendment 2026-07-27]: omitting BOTH tracks means "deliver what's
  // there" — the natural authoring shape (`output: {container: "mp4"}`),
  // which the NL guide's own examples use. Under strict omission semantics
  // it meant "no video, no audio" and lowered to ZERO spans with no error.
  // An omission is a deliberate drop only when the other track is present.
  const pixelOnly = op.output.container === 'png' || op.output.container === 'jpeg' || op.output.container === 'gif';
  if (!op.output.video && !op.output.audio && !pixelOnly) {
    if (op.output.container === 'mp3' || op.output.container === 'wav' || op.output.container === 'ogg') {
      op.output.audio = {};
    } else {
      if (hasVideoContent) op.output.video = {};
      op.output.audio = {};
    }
  }
  if (op.output.video && !hasVideoContent) {
    errors.push(err('video-output-without-video', `${opPath}.output.video`, 'output requires video but the timeline has none [D4]'));
  }
  // [D5] output.fps: for all-still (ticker-driven) outputs it names the tick
  // rate; for decoded video it becomes the plan's CFR conform target — the
  // executor's conform sink duplicates/drops onto the fps grid (ffmpeg
  // fps-filter semantics). Meaningless for single-frame outputs.
  const allStillSlots = slots.length > 0 && slots.every((s) => factsOf(facts, s.baseAsset)?.kind === 'image');
  if (op.output.fps !== undefined) {
    if (stillOutput) {
      errors.push(err('usage-unavailable', `${opPath}.output.fps`, 'fps has no meaning for a single-frame output'));
    } else if (op.output.fps < 1 || op.output.fps > 120) {
      errors.push(err('usage-unavailable', `${opPath}.output.fps`, 'fps must be between 1 and 120'));
    }
  }
  const tickFps = Math.min(60, Math.max(1, op.output.fps ?? 30));
  if (errors.length) return { plan: null, errors };
  const CV: Geometry = canvas ?? { w: 2, h: 2 };
  /** Placement/boxes resolve against the COMPOSED space; the output chain then
   * maps composed space → final canvas. Identity when no top-level effects. */
  const composedCV: Geometry = composedCanvas ?? CV;

  // Upscale kernel [U1/U2]: composite runs at CV; the kernel maps CV → the
  // encoder canvas (explicit resolution wins; else CV × scale).
  let videoKernels: VideoKernelDecl[] | undefined;
  let encodeCanvas: Geometry = CV;
  if (upscaleFx && upscaleFx.type === 'upscale') {
    if (!hasVideoContent || !op.output.video) {
      errors.push(err('usage-unavailable', `${opPath}.effects`, 'upscale requires video content'));
      return { plan: null, errors };
    }
    const s = upscaleFx.scale ?? 2;
    const to: Geometry = op.output.resolution
      ? { w: op.output.resolution.width, h: op.output.resolution.height }
      : { w: even(CV.w * s), h: even(CV.h * s) };
    videoKernels = [{ op: 'upscale', params: { model: upscaleFx.model ?? 'auto', from: { ...CV }, to } }];
    encodeCanvas = to;
  }
  const applyOutputChain = (m: Mat): Mat => outputChain ? mul(outputChain.F, m) : m;
  /** Top-level color effects compose OVER each layer's own color chain. */
  const applyOutputColor = (cx: ColorXf | undefined): ColorXf | undefined => {
    const oc = outputChain?.color;
    if (!oc) return cx;
    return cx ? colorMul(oc, cx) : oc;
  };

  // ---- contributors -------------------------------------------------------
  const visuals: VisualContrib[] = [];
  const audios: AudioContrib[] = [];
  const audioReplaced = !!op.output.audio?.from;

  slots.forEach((s, i) => {
    const slotEnd = s.pos + s.duration;
    const fadeInT = i > 0 ? (overlapAfter[i - 1] ?? 0) : 0;
    const fadeOutT = overlapAfter[i] ?? 0;
    const baseChain = baseChains.get(i);
    const f = factsOf(facts, s.baseAsset)!;

    if (baseChain && op.output.video) {
      const basePlace = s.item.type === 'composition' && s.item.layers[0]!.type !== 'audio'
        ? s.item.layers[0]!.place : undefined;
      const box = basePlace ? placeBox(basePlace, baseChain.geom, composedCV) : { x: 0, y: 0, w: composedCV.w, h: composedCV.h };
      const baseOpacity = s.item.type === 'composition' && s.item.layers[0]!.type !== 'audio'
        ? (s.item.layers[0]!.opacity ?? 1) : 1;
      const baseIsImage = f.kind === 'image';   // image base [D7a] → static slot
      const v: VisualContrib = {
        asset: s.baseAsset, isImage: baseIsImage, chain: baseChain, box,
        opacity: baseOpacity, outStart: s.pos, srcStart: baseIsImage ? 0 : s.baseRange!.start,
        activeFrom: s.pos, activeTo: slotEnd, isBase: true,
      };
      if (s.speed !== 1) v.rate = s.speed;
      if (fadeInT > 0) v.ramp = { from: 0, to: baseOpacity, over: [s.pos, s.pos + fadeInT] };
      visuals.push(v);
    }

    // base audio
    if (!audioReplaced && f.audio) {
      const vol = s.item.type === 'clip' ? resolveVolume(s.item.volume)
        : s.item.layers[0]!.type !== 'image' ? resolveVolume(s.item.layers[0]!.volume) : 1;
      const a: AudioContrib = {
        asset: s.baseAsset, gain: vol, outStart: s.pos, srcStart: s.baseRange!.start,
        activeFrom: s.pos, activeTo: slotEnd,
      };
      if (s.speed !== 1) a.rate = s.speed;
      if (fadeInT > 0) a.fadeIn = [s.pos, s.pos + fadeInT];
      if (fadeOutT > 0) a.fadeOut = [slotEnd - fadeOutT, slotEnd];
      audios.push(a);
    }

    // composition non-base layers
    if (s.item.type === 'composition') {
      s.item.layers.slice(1).forEach((layer, li) => {
        const lp = `${s.path}.layers[${li + 1}]`;
        const lf = factsOf(facts, layer.source);
        if (!lf) { errors.push(err('unknown-reference', lp, `no facts for '${layer.source}'`)); return; }
        const at = layer.at !== undefined ? resolveTime(layer.at, s.duration) : 0;
        const activeFrom = s.pos + at;
        if (layer.type === 'audio') {
          if (!lf.audio) { errors.push(err('usage-unavailable', lp, `'${layer.source}' has no audio track`)); return; }
          if (audioReplaced) return;
          const r = resolveRange(layer.range, lf.duration);
          audios.push({
            asset: layer.source, gain: resolveVolume(layer.volume),
            outStart: activeFrom, srcStart: r.start, activeFrom,
            activeTo: Math.min(s.pos + s.duration, activeFrom + (r.end - r.start)),
            ...(fadeOutT > 0 ? { fadeOut: [s.pos + s.duration - fadeOutT, s.pos + s.duration] as [Sec, Sec] } : {}),
          });
          return;
        }
        // visual layer
        if (!op.output.video) return;
        const isImage = lf.kind === 'image';
        if (layer.type === 'image' && !isImage) { errors.push(err('usage-unavailable', lp, `'${layer.source}' is not an image`)); return; }
        if (layer.type === 'video' && !lf.video) { errors.push(err('usage-unavailable', lp, `'${layer.source}' has no video track`)); return; }
        const g0 = isImage ? { w: lf.image!.width, h: lf.image!.height } : { w: lf.video!.width, h: lf.video!.height };
        const chain = foldEffects(g0, layer.effects, lp, errors);
        const box = placeBox(layer.place!, chain.geom, composedCV);
        const r = isImage ? { start: 0, end: Infinity } : resolveRange(layer.range, lf.duration);
        visuals.push({
          asset: layer.source, isImage, chain, box,
          opacity: layer.opacity ?? 1, outStart: activeFrom, srcStart: r.start,
          activeFrom, activeTo: isImage ? s.pos + s.duration : Math.min(s.pos + s.duration, activeFrom + (r.end - r.start)),
        });
        if (layer.type === 'video' && layer.audio && lf.audio && !audioReplaced) {
          audios.push({
            asset: layer.source, gain: resolveVolume(layer.volume),
            outStart: activeFrom, srcStart: r.start, activeFrom,
            activeTo: Math.min(s.pos + s.duration, activeFrom + (r.end - r.start)),
          });
        }
      });
    }
  });

  // overlays [O1]
  op.overlays?.forEach((ov, vi) => {
    const path = `${opPath}.overlays[${vi}]`;
    const f = factsOf(facts, ov.source);
    if (!f) { errors.push(err('unknown-reference', path, `no facts for '${ov.source}'`)); return; }
    const from = ov.from !== undefined ? resolveTime(ov.from, outputDuration) : 0;
    let to = ov.to !== undefined ? resolveTime(ov.to, outputDuration)
      : ov.duration !== undefined ? from + resolveTime(ov.duration, outputDuration) : outputDuration;
    to = Math.min(to, outputDuration);
    if (to - from <= EPS || from < -EPS) { errors.push(err('window-invalid', path, `window [${from}, ${to}) is empty or out of bounds`)); return; }
    if (ov.type === 'captions') {
      if (f.kind !== 'timed-text') { errors.push(err('usage-unavailable', path, `'${ov.source}' is ${f.kind}, not timed-text`)); return; }
      if (!op.output.video || !hasVideoContent) return;
      // wrapping box + text size resolved against the COMPOSED canvas [O5]
      const box = placeBox({
        anchor: ov.place?.anchor ?? 'bottom',
        margin: ov.place?.margin ?? '5%',
        width: ov.place?.width ?? '80%',
        height: ov.place?.height ?? '35%',
        ...(ov.place?.x !== undefined ? { x: ov.place.x } : {}),
        ...(ov.place?.y !== undefined ? { y: ov.place.y } : {}),
      }, { w: 1, h: 1 }, composedCV);
      const captions: CaptionSlotSpec = {
        asset: ov.source.split('.')[0]!,
        style: ov.style ?? 'shadow',
        color: ov.color ?? '#ffffff',
        font: ov.font ?? 'Helvetica',
        ...(ov.background ? { bar: true } : {}),
        sizePx: Math.round(resolveSpace(ov.size ?? '7%', composedCV.h)),
        box: rr(box),
      };
      visuals.push({
        asset: ov.source, isImage: false,
        chain: { srcRect: { x: 0, y: 0, w: composedCV.w, h: composedCV.h }, geom: { ...composedCV }, F: I },
        box: { x: 0, y: 0, w: composedCV.w, h: composedCV.h },
        opacity: 1, outStart: from, srcStart: 0, activeFrom: from, activeTo: to,
        captions,
      });
      return;
    }
    if (ov.type === 'audio') {
      if (!f.audio) { errors.push(err('usage-unavailable', path, `'${ov.source}' has no audio track`)); return; }
      if (audioReplaced) return;
      const r = resolveRange(ov.range, f.duration);
      audios.push({
        asset: ov.source, gain: resolveVolume(ov.volume),
        outStart: from, srcStart: r.start, activeFrom: from,
        activeTo: Math.min(to, from + (r.end - r.start)),
      });
      return;
    }
    if (!op.output.video) return;
    const isImage = f.kind === 'image';
    if (ov.type === 'image' && !isImage) { errors.push(err('usage-unavailable', path, `'${ov.source}' is not an image`)); return; }
    if (ov.type === 'video' && !f.video) { errors.push(err('usage-unavailable', path, `'${ov.source}' has no video track`)); return; }
    const g0 = isImage ? { w: f.image!.width, h: f.image!.height } : { w: f.video!.width, h: f.video!.height };
    const chain = foldEffects(g0, undefined, path, errors);
    const box = placeBox(ov.place, chain.geom, composedCV);
    const r = isImage ? { start: 0, end: Infinity } : resolveRange('range' in ov ? ov.range : undefined, f.duration);
    visuals.push({
      asset: ov.source, isImage, chain, box, opacity: ov.opacity ?? 1,
      outStart: from, srcStart: r.start, activeFrom: from,
      activeTo: isImage ? to : Math.min(to, from + (r.end - r.start)),
    });
    if (ov.type === 'video' && ov.audio && f.audio && !audioReplaced) {
      audios.push({
        asset: ov.source, gain: resolveVolume(ov.volume),
        outStart: from, srcStart: r.start, activeFrom: from, activeTo: to,
      });
    }
  });

  // wired audio [D2, D3]
  if (audioReplaced && op.output.audio) {
    const src = op.output.audio.from!;
    const f = factsOf(facts, src);
    if (!f?.audio) errors.push(err('usage-unavailable', `${opPath}.output.audio.from`, `'${src}' has no audio track`));
    else audios.push({
      asset: src, gain: 1, outStart: 0, srcStart: 0,
      activeFrom: 0, activeTo: Math.min(outputDuration, f.duration),
    });
  }
  if (!op.output.audio) audios.length = 0;

  // Denoise kernel [H1/H3]: one streaming instance over the final mixed audio.
  let audioKernels: AudioKernelDecl[] | undefined;
  if (denoiseFx && denoiseFx.type === 'denoise') {
    if (!op.output.audio || audios.length === 0) {
      errors.push(err('usage-unavailable', `${opPath}.effects`, 'denoise requires an audio track in the output'));
    } else {
      audioKernels = [{ op: 'denoise', params: { model: denoiseFx.model ?? 'auto' } }];
    }
  }
  // [H4] adaptive leveling chains AFTER denoise (level the cleaned signal)
  if (levelFx && levelFx.type === 'level') {
    if (!op.output.audio || audios.length === 0) {
      errors.push(err('usage-unavailable', `${opPath}.effects`, 'level requires an audio track in the output'));
    } else {
      audioKernels = [...(audioKernels ?? []), { op: 'level', params: { target: levelFx.target ?? -16 } }];
    }
  }
  if (errors.length) return { plan: null, errors };

  // ---- unified boundary sweep [N2] ---------------------------------------
  const bounds = new Set<number>([0, outputDuration]);
  for (const v of visuals) { bounds.add(v.activeFrom); bounds.add(v.activeTo); }
  for (const a of audios) {
    bounds.add(a.activeFrom); bounds.add(a.activeTo);
    if (a.fadeIn) { bounds.add(a.fadeIn[0]); bounds.add(a.fadeIn[1]); }
    if (a.fadeOut) { bounds.add(a.fadeOut[0]); bounds.add(a.fadeOut[1]); }
  }
  for (const v of visuals) if (v.ramp) { bounds.add(v.ramp.over[0]); bounds.add(v.ramp.over[1]); }
  const cuts = [...bounds].filter((t) => t > -EPS && t < outputDuration + EPS).sort((a, b) => a - b);
  const merged: number[] = [];
  for (const t of cuts) if (!merged.length || t - merged[merged.length - 1]! > EPS) merged.push(t);

  const spans: Span[] = [];
  const audioRates: number[] = [];

  for (let bi = 0; bi + 1 < merged.length; bi++) {
    const s = merged[bi]!; const e = merged[bi + 1]!;
    const mid = (s + e) / 2;

    const activeV = visuals.filter((v) => v.activeFrom - EPS <= mid && mid < v.activeTo - EPS + 2 * EPS && mid < v.activeTo + EPS);
    const activeA = audios.filter((a) => a.activeFrom - EPS <= mid && mid < a.activeTo + EPS);

    const span: Span = { start: round6(s), end: round6(e) };

    if (activeV.length && op.output.video) {
      const bindings: SlotBinding[] = [];
      const staticSlots: Record<number, string> = {};
      const captionSlots: Record<number, CaptionSlotSpec> = {};
      const layers: PlanLayer[] = [];
      const opacityRamps: Record<number, ParamRamp> = {};
      let slot = 0;
      for (const v of activeV) {
        const layerIdx = layers.length;
        if (v.captions) {
          captionSlots[slot] = v.captions;
        } else if (v.isImage) {
          staticSlots[slot] = v.asset;
        } else {
          const rate = v.rate ?? 1;
          const srcStart = v.srcStart + (s - v.outStart) * rate;
          bindings.push({
            slot, asset: v.asset.split('.')[0]!, track: 'video',
            sourceStart: round6(srcStart), sourceEnd: round6(srcStart + (e - s) * rate),
            offset: round6(s - srcStart / rate),
            ...(rate !== 1 ? { rate } : {}),
          });
        }
        const color = applyOutputColor(v.chain.color);
        layers.push({
          input: slot,
          srcRect: rr(v.chain.srcRect),
          transform: applyOutputChain(layerTransform(v.chain, v.box)).map(round6) as PlanLayer['transform'],
          opacity: v.ramp && v.ramp.over[1] > s + EPS && v.ramp.over[0] < e - EPS ? v.ramp.from : v.opacity,
          blend: 'over',
          ...(color ? {
            color: {
              matrix: color.m.map(round6) as NonNullable<PlanLayer['color']>['matrix'],
              offset: color.o.map(round6) as NonNullable<PlanLayer['color']>['offset'],
            },
          } : {}),
          ...(v.chain.filters?.length ? { filters: v.chain.filters } : {}),
        });
        if (v.ramp && v.ramp.over[0] < e - EPS && v.ramp.over[1] > s + EPS) {
          opacityRamps[layerIdx] = v.ramp;
        }
        slot++;
      }
      // background precedence: the span's base pad color (outgoing slot
      // during a crossfade) → a top-level pad color → output.background
      const fill = activeV.find((v) => v.isBase && v.chain.fill)?.chain.fill
        ?? outputChain?.fill ?? op.output.background;
      const lane: VideoLanePlan = {
        bindings,
        composite: {
          canvas: CV, layers,
          ...(fill ? { background: hex01(fill).map(round6) as [number, number, number] } : {}),
          // top-level non-affine remainder — applied to the composed frame
          ...(outputChain?.filters?.length ? { postFilters: outputChain.filters } : {}),
        },
      };
      if (Object.keys(staticSlots).length) lane.staticSlots = staticSlots;
      if (Object.keys(captionSlots).length) lane.captionSlots = captionSlots;
      if (Object.keys(opacityRamps).length) lane.opacityRamps = opacityRamps;
      // [D7b] no decode stream drives this span — the executor ticks at CFR
      if (!bindings.length && !stillOutput) lane.tick = tickFps;
      span.video = lane;
    }

    if (activeA.length && op.output.audio) {
      const bindings: SlotBinding[] = [];
      const gainRamps: Record<number, ParamRamp> = {};
      activeA.forEach((a, slot) => {
        const rate = a.rate ?? 1;
        const srcStart = a.srcStart + (s - a.outStart) * rate;
        bindings.push({
          slot, asset: a.asset.split('.')[0]!, track: 'audio',
          sourceStart: round6(srcStart), sourceEnd: round6(srcStart + (e - s) * rate),
          offset: round6(s - srcStart / rate),
          ...(rate !== 1 ? { rate } : {}),
        });
        const f = factsOf(facts, a.asset);
        if (f?.audio) audioRates.push(f.audio.sampleRate);
        // effective gain over this span: static gain × transition ramps
        const rampIn = a.fadeIn && a.fadeIn[0] < e - EPS && a.fadeIn[1] > s + EPS ? a.fadeIn : null;
        const rampOut = a.fadeOut && a.fadeOut[0] < e - EPS && a.fadeOut[1] > s + EPS ? a.fadeOut : null;
        if (rampIn) gainRamps[slot] = { from: 0, to: a.gain, over: [round6(rampIn[0]), round6(rampIn[1])] };
        else if (rampOut) gainRamps[slot] = { from: a.gain, to: 0, over: [round6(rampOut[0]), round6(rampOut[1])] };
        else if (a.gain !== 1) gainRamps[slot] = { from: a.gain, to: a.gain, over: [round6(s), round6(e)] };
      });
      const mix = activeA.length > 1 || Object.keys(gainRamps).length > 0;
      const lane: AudioLanePlan = { bindings, mode: mix ? 'mix' : 'single' };
      if (Object.keys(gainRamps).length) lane.gainRamps = gainRamps;
      span.audio = lane;
    }

    if (span.video || span.audio) spans.push(span);
  }

  // ---- stream-copy negotiation [D1] --------------------------------------
  // copy iff the track reaches the output untouched ∧ codec container-legal ∧
  // declaration unpinned (explicit codec/quality/bitrate = the user asked for
  // an encode). Judged on CONTRIBUTORS, not spans: overlay/audio boundaries
  // may split spans without touching the other lane.
  const isImageOutput = op.output.container === 'png' || op.output.container === 'jpeg';
  // gif has no muxer and always renders through the custom encoder [D9]
  const noCopyContainer = isImageOutput || op.output.container === 'gif';
  const container = op.output.container as ContainerId;
  const isIdentity = (m: Mat): boolean => m.every((v, i) => Math.abs(v - I[i]!) < 1e-4);

  let videoCopy: CopyTrackDecl | null = null;
  if (!noCopyContainer && op.output.video && hasVideoContent
    && !videoKernels // a kernel transforms pixels — copy never applies [D1]
    && op.output.fps === undefined // CFR conform re-times frames — an encode [D5]
    && !op.output.video.bitrate && !op.output.video.quality
    && (!op.output.video.codec || op.output.video.codec === 'auto')
    && visuals.length === 1) {
    const v = visuals[0]!;
    const vf = factsOf(facts, v.asset);
    const vt = vf?.video;
    if (vt?.codec && (vt.rotation ?? 0) === 0 && (vt.firstTimestamp ?? -1) >= -EPS
      && !v.isImage && !v.ramp && v.opacity === 1 && (v.rate ?? 1) === 1
      // full source, aligned with output time, uncut
      && Math.abs(v.outStart) < EPS && Math.abs(v.srcStart) < EPS && Math.abs(v.activeFrom) < EPS
      && Math.abs(v.activeTo - outputDuration) < EPS && Math.abs(outputDuration - vf!.duration) < EPS
      // pixel-identity: full frame sampled, canvas = source geometry, net
      // transform (incl. top-level effects) is the identity, no color/filter work
      && !v.chain.color && !outputChain?.color
      && !v.chain.filters?.length && !outputChain?.filters?.length
      && Math.abs(v.chain.srcRect.x) < EPS && Math.abs(v.chain.srcRect.y) < EPS
      && Math.abs(v.chain.srcRect.w - vt.width) < EPS && Math.abs(v.chain.srcRect.h - vt.height) < EPS
      && CV.w === vt.width && CV.h === vt.height
      && isIdentity(applyOutputChain(layerTransform(v.chain, v.box)))
      && canCopyCodec(container, 'video', vt.codec)) {
      videoCopy = { asset: v.asset.split('.')[0]!, codec: vt.codec, end: round6(outputDuration) };
    }
  }

  let audioCopy: CopyTrackDecl | null = null;
  if (!noCopyContainer && op.output.audio && audios.length === 1
    && !audioKernels // a kernel transforms samples — copy never applies [D1]
    && !op.output.audio.bitrate
    && (!op.output.audio.codec || op.output.audio.codec === 'auto')) {
    const a = audios[0]!;
    const at = factsOf(facts, a.asset)?.audio;
    // an explicit sampleRate equal to the source is a no-op [D6]; different = resample = re-encode
    const resampled = op.output.audio.sampleRate !== undefined && op.output.audio.sampleRate !== at?.sampleRate;
    if (at?.codec && !resampled && (a.rate ?? 1) === 1
      && (at.firstTimestamp ?? -1) >= -EPS && a.gain === 1 && !a.fadeIn && !a.fadeOut
      // starts at source 0 on output 0; end truncation is allowed (audio
      // packets are independently decodable)
      && Math.abs(a.outStart) < EPS && Math.abs(a.srcStart) < EPS && Math.abs(a.activeFrom) < EPS
      && canCopyCodec(container, 'audio', at.codec)) {
      audioCopy = { asset: a.asset.split('.')[0]!, codec: at.codec, end: round6(a.activeTo) };
    }
  }

  // ---- assemble -----------------------------------------------------------
  const outDecl: OutputDecl = { container: op.output.container };
  if (op.output.video && hasVideoContent) {
    outDecl.video = { from: { node: op.id } };
    if (op.output.video.codec && op.output.video.codec !== 'auto') outDecl.video.codec = op.output.video.codec;
    if (op.output.video.quality) outDecl.video.quality = op.output.video.quality;
    if (op.output.video.bitrate) outDecl.video.bitrate = op.output.video.bitrate;
  }
  const hasAudio = audios.length > 0;
  if (op.output.audio && hasAudio) {
    outDecl.audio = { from: { node: op.id } };
    // 'mp3' passes through container preference in buildOutput; the plan's
    // codec field carries only the executor-schema subset
    if (op.output.audio.codec && op.output.audio.codec !== 'auto' && op.output.audio.codec !== 'mp3') {
      outDecl.audio.codec = op.output.audio.codec;
    }
    if (op.output.audio.bitrate) outDecl.audio.bitrate = op.output.audio.bitrate;
  }

  const plan: CompiledPlan = {
    schemaVersion: '0.1.0',
    canvas: encodeCanvas,
    output: outDecl,
    strategy: {
      video: videoCopy ? 'copy' : 'reencode',
      audio: hasAudio ? (audioCopy ? 'copy' : 'reencode') : 'none',
    },
    spans,
    // conform target for DECODED video [D5]; all-still outputs already tick
    // at the requested rate, so no conform pass is layered on top
    ...(op.output.fps !== undefined && !stillOutput && !allStillSlots ? { fps: op.output.fps } : {}),
  };
  if (videoKernels) {
    plan.compositeCanvas = CV;
    plan.videoKernels = videoKernels;
  }
  if (audioKernels) plan.audioKernels = audioKernels;
  if (videoCopy || audioCopy) {
    plan.copy = {};
    if (videoCopy) plan.copy.video = videoCopy;
    if (audioCopy) plan.copy.audio = audioCopy;
  }
  // [D8] soft subtitles: delivery wiring, validated against facts
  if (op.output.subtitles) {
    const src = op.output.subtitles.from;
    const sf = factsOf(facts, src);
    if (!sf) errors.push(err('unknown-reference', `${opPath}.output.subtitles.from`, `no facts for '${src}'`));
    else if (sf.kind !== 'timed-text') {
      errors.push(err('usage-unavailable', `${opPath}.output.subtitles.from`,
        `'${src}' is ${sf.kind}, not timed-text (extracting subtitle tracks from videos is not supported — Mediabunny upstream gap)`));
    } else {
      outDecl.subtitles = { asset: src.split('.')[0]! };
      if (op.output.subtitles.language) outDecl.subtitles.language = op.output.subtitles.language;
    }
    if (errors.length) return { plan: null, errors };
  }

  // [D7] single-frame extraction: resolve `at` on the OUTPUT clock
  if (isImageOutput) {
    let t = op.output.at !== undefined ? resolveTime(op.output.at, outputDuration) : 0;
    if (t < -EPS || t > outputDuration + EPS) {
      errors.push(err('window-invalid', `${opPath}.output.at`, `frame time ${t} outside output [0, ${outputDuration}]`));
      return { plan: null, errors };
    }
    // 'end'/100% means the last frame, not one past it
    t = Math.min(Math.max(t, 0), Math.max(0, outputDuration - 1e-3));
    plan.still = { time: round6(t) };
    if (op.output.container === 'jpeg') {
      plan.still.quality = { low: 0.7, medium: 0.85, high: 0.95 }[op.output.video?.quality ?? 'high'];
    }
  }
  if (hasAudio) {
    plan.audioFormat = {
      // Denoise runs at DFN's native 48 kHz [H2] — defaulting the output there
      // avoids a double resample; an explicit sampleRate still wins.
      rate: op.output.audio?.sampleRate ?? (audioKernels ? 48000 : audioRates[0] ?? 48000),
      channels: 2,
    };
  }
  return { plan, errors };
}

// ---------------------------------------------------------------------------
// placeBox lives in ./place — shared with the app's placement widgets [G1].

const even = (n: number) => Math.max(2, 2 * Math.round(n / 2));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const rr = (r: Rect) => ({ x: round6(r.x), y: round6(r.y), w: round6(r.w), h: round6(r.h) });
