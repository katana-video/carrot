/**
 * Filter pass planning + shader codegen (docs/filters-gpu-plan.md §4).
 *
 * A FilterStep chain becomes the minimum number of GPU passes: consecutive
 * pointwise steps collapse into ONE generated fragment shader (snippet
 * concatenation — template codegen from validated plan data, never
 * model-authored shader text); blur is two separable passes; sharpen is a
 * three-draw sub-sequence (blurX, blurY, combine-with-original) the backends
 * expand; pixelate is a sampling pass. Every pass's parameters are BAKED into
 * the generated source as literals (specs are static per plan) — the only
 * runtime input is the frame time for grain, a single small uniform on
 * passes that need it (`passNeedsTime`).
 *
 * Pointwise passes work in STRAIGHT color: un-premultiply once, apply all
 * steps, re-premultiply — nonlinear ops (levels/threshold/posterize/vibrance)
 * have no premultiplied-exact form, and for the affine ones the result is
 * identical up to fp. Convolution (blur/sharpen) filters premultiplied color
 * directly — the correct way to filter partially-transparent content.
 *
 * The planner and pass model are shared; snippet bodies exist twice (GLSL ES
 * 3.0 for webgl2, WGSL for webgpu). Grain uses an integer PCG hash on pixel
 * coordinates so the two backends produce IDENTICAL noise — cross-backend
 * equivalence stays testable. The e5 page is the truth harness.
 */

import type { FilterStep, Geometry, Rect } from '../schema';

// ---------------------------------------------------------------------------
// Pass model
// ---------------------------------------------------------------------------

const POINTWISE = new Set(['colorMatrix', 'levels', 'threshold', 'posterize', 'vibrance', 'grain', 'vignette']);
export type PointwiseStep = Extract<FilterStep,
  { op: 'colorMatrix' } | { op: 'levels' } | { op: 'threshold' } | { op: 'posterize' }
  | { op: 'vibrance' } | { op: 'grain' } | { op: 'vignette' }>;

export type FilterPass =
  /** One fragment shader applying `steps` in order. May carry the srcRect
   * extraction remap (pass 0 of a per-layer chain). */
  | { kind: 'pointwise'; steps: PointwiseStep[] }
  | { kind: 'blur'; axis: 'x' | 'y'; radius: number }
  /** Backends expand to three draws via sharpenSources* (needs the pass input
   * kept alive — two scratch textures). */
  | { kind: 'sharpen'; amount: number; radius: number }
  | { kind: 'pixelate'; size: number };

const isPointwise = (s: FilterStep): s is PointwiseStep => POINTWISE.has(s.op);

/**
 * FilterStep[] → passes. Always returns at least one pass — pass 0 doubles as
 * the srcRect extraction draw (per-layer chains sample the source region into
 * the first intermediate), so an empty chain still plans to a single copy.
 */
export function planFilterPasses(filters: FilterStep[]): FilterPass[] {
  const passes: FilterPass[] = [];
  let run: PointwiseStep[] | null = null;
  for (const step of filters) {
    if (isPointwise(step)) {
      if (!run) { run = []; passes.push({ kind: 'pointwise', steps: run }); }
      run.push(step);
      continue;
    }
    run = null;
    if (step.op === 'blur') {
      passes.push({ kind: 'blur', axis: 'x', radius: step.radius });
      passes.push({ kind: 'blur', axis: 'y', radius: step.radius });
    } else if (step.op === 'sharpen') {
      passes.push({ kind: 'sharpen', amount: step.amount, radius: step.radius });
    } else {
      passes.push({ kind: 'pixelate', size: step.size });
    }
  }
  // pass 0 must be able to carry the extraction remap; a chain that starts
  // with a non-pointwise pass gets a plain copy prepended (blur offsets are
  // authored in intermediate-texture space, and sharpen needs a plain input
  // texture it can bind twice).
  if (passes.length === 0 || passes[0]!.kind !== 'pointwise') {
    passes.unshift({ kind: 'pointwise', steps: [] });
  }
  return passes;
}

/** Grain re-seeds per frame — such passes take the time uniform. */
export const passNeedsTime = (p: FilterPass): boolean =>
  p.kind === 'pointwise' && p.steps.some((s) => s.op === 'grain');

// ---------------------------------------------------------------------------
// Codegen helpers
// ---------------------------------------------------------------------------

/** GLSL/WGSL float literal — integers need the trailing ".0". */
const f = (n: number): string => {
  if (!Number.isFinite(n)) throw new Error(`non-finite shader literal: ${n}`);
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
};

/** Gaussian taps: σ = radius, half-width capped (huge blurs would need a
 * downsample pyramid — out of scope; lower clamps radii accordingly). */
export const blurTaps = (radius: number): number =>
  Math.max(1, Math.min(64, Math.ceil(radius * 2.5)));

/** Normalized srcRect remap for pass 0, or null for identity (post chains). */
export interface Extraction { srcRect: Rect; source: Geometry }

const remapExpr = (ex: Extraction | null, uv: string): string => {
  if (!ex) return uv;
  const { srcRect: r, source: g } = ex;
  return `(vec2(${f(r.x / g.w)}, ${f(r.y / g.h)}) + ${uv} * vec2(${f(r.w / g.w)}, ${f(r.h / g.h)}))`;
};

// row-major 3×3 → column-major constructor args
const columns = (m: readonly number[]): number[] =>
  [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];

const LUMA = '0.2126, 0.7152, 0.0722';

/**
 * Straight-space statement(s) for one pointwise step, shared shape for both
 * languages via tiny syntax shims. `s` is straight vec3 rgb in [0,1]; `uv`
 * and baked constants provide position; grain additionally reads the time
 * uniform (T) and calls pcg().
 */
interface Syn {
  vec3(x: string): string;       // splatted vec3 constructor
  mat3(cols: string[]): string;  // 9 column-major args
  uv: string;
  T: string;                     // time uniform expression
  f32: string;                   // float cast fn name
  u32: string;                   // uint cast fn name
  uvec2: string;
  suffix: string;                // integer literal suffix ('u')
}

function stepBody(step: PointwiseStep, size: Geometry, x: Syn): string {
  switch (step.op) {
    case 'colorMatrix': {
      const m = x.mat3(columns(step.matrix).map(f));
      const [a, b, c] = step.offset;
      return `  s = clamp(${m} * s + vec3(${f(a)}, ${f(b)}, ${f(c)}), ${x.vec3('0.0')}, ${x.vec3('1.0')});`;
    }
    case 'levels': {
      const span = Math.max(step.inWhite - step.inBlack, 1e-4);
      return `  s = pow(clamp((s - ${x.vec3(f(step.inBlack))}) * ${f(1 / span)}, ${x.vec3('0.0')}, ${x.vec3('1.0')}), ${x.vec3(f(1 / step.gamma))});`;
    }
    case 'threshold':
      return `  s = ${x.vec3(`step(${f(step.cutoff)}, dot(s, vec3(${LUMA})))`)};`;
    case 'posterize': {
      const n = Math.max(2, Math.round(step.levels)) - 1;
      return `  s = round(s * ${f(n)}) * ${f(1 / n)};`;
    }
    case 'vibrance':
      return `  {
    let mx = max(s.r, max(s.g, s.b));
    let mn = min(s.r, min(s.g, s.b));
    let l = dot(s, vec3(${LUMA}));
    s = clamp(mix(${x.vec3('l')}, s, 1.0 + ${f(step.amount)} * (1.0 - (mx - mn))), ${x.vec3('0.0')}, ${x.vec3('1.0')});
  }`;
    case 'grain':
      // deterministic integer hash on pixel coords + frame seed — identical
      // noise on both backends; amplitude ±0.12 at amount 1
      return `  {
    let ip = ${x.uvec2}(${x.uv} * vec2(${f(size.w)}, ${f(size.h)}));
    let h = pcg(ip.x + ip.y * 7919${x.suffix} + ${x.u32}(${x.T} * 1000.0 + 0.5) * 15486047${x.suffix});
    let n = ${x.f32}(h) * (1.0 / 4294967295.0);
    s = clamp(s + ${x.vec3(`(n - 0.5) * ${f(0.24 * step.amount)}`)}, ${x.vec3('0.0')}, ${x.vec3('1.0')});
  }`;
    case 'vignette': {
      const start = Math.min(1 - step.size, 0.999);
      // d: 0 at center, 1 at the corners (aspect ignored — radial in uv)
      return `  {
    let d = length((${x.uv} - vec2(0.5, 0.5)) * 2.0) * 0.7071068;
    s = s * (1.0 - ${f(step.strength)} * smoothstep(${f(start)}, 1.0, d));
  }`;
    }
  }
}

const GLSL_SYN: Syn = {
  vec3: (v) => `vec3(${v})`,
  mat3: (c) => `mat3(${c.join(', ')})`,
  uv: 'vUv', T: 'uT', f32: 'float', u32: 'uint', uvec2: 'uvec2', suffix: 'u',
};
const WGSL_SYN: Syn = {
  vec3: (v) => `vec3(${v})`,
  mat3: (c) => `mat3x3<f32>(vec3(${c.slice(0, 3).join(', ')}), vec3(${c.slice(3, 6).join(', ')}), vec3(${c.slice(6, 9).join(', ')}))`,
  uv: 'in.uv', T: 'uni.t', f32: 'f32', u32: 'u32', uvec2: 'vec2<u32>', suffix: 'u',
};

// GLSL has no `let`; the shared bodies use `let` and GLSL rewrites it.
const glslify = (body: string): string => body
  .replace(/\blet mx\b/g, 'float mx').replace(/\blet mn\b/g, 'float mn')
  .replace(/\blet l\b/g, 'float l').replace(/\blet d\b/g, 'float d')
  .replace(/\blet ip\b/g, 'uvec2 ip').replace(/\blet h\b/g, 'uint h')
  .replace(/\blet n\b/g, 'float n');

const PCG_GLSL = `uint pcg(uint v) {
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}`;
const PCG_WGSL = `fn pcg(vin: u32) -> u32 {
  var v = vin * 747796405u + 2891336453u;
  let w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}`;

// ---------------------------------------------------------------------------
// GLSL (webgl2)
// ---------------------------------------------------------------------------

/** Shared fullscreen vertex shader: quad from gl_VertexID, vUv row-0-at-v-0
 * (matches texture upload orientation — passes are orientation-identity). */
export const FILTER_VS_GLSL = /* glsl */ `#version 300 es
precision highp float;
out vec2 vUv;
void main() {
  vec2 quad[6] = vec2[6](
    vec2(0.,0.), vec2(1.,0.), vec2(0.,1.),
    vec2(1.,0.), vec2(1.,1.), vec2(0.,1.));
  vUv = quad[gl_VertexID];
  gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
}`;

const blurBodyGlsl = (axis: 'x' | 'y', radius: number, inputSize: Geometry): string => {
  const R = blurTaps(radius);
  const inv2s2 = -1 / (2 * radius * radius);
  const px = axis === 'x' ? `vec2(${f(1 / inputSize.w)}, 0.0)` : `vec2(0.0, ${f(1 / inputSize.h)})`;
  // premultiplied color blurs directly; clamp-to-edge renormalizes borders
  return `  vec2 px = ${px};
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -${R}; i <= ${R}; i++) {
    float w = exp(float(i * i) * ${f(inv2s2)});
    acc += w * texture(uTex, vUv + float(i) * px);
    wsum += w;
  }
  outColor = acc / wsum;`;
};

/** Fragment source for one pass. `inputSize` is the size of the texture the
 * pass samples; `extraction` remaps pass 0 of a per-layer chain. Sharpen is
 * not a single draw — use sharpenSourcesGlsl. */
export function passFragmentGlsl(pass: FilterPass, inputSize: Geometry, extraction: Extraction | null): string {
  if (pass.kind === 'sharpen') throw new Error('sharpen expands via sharpenSourcesGlsl');
  const needsTime = passNeedsTime(pass);
  const hasGrain = pass.kind === 'pointwise' && pass.steps.some((s) => s.op === 'grain');
  const head = `#version 300 es
precision highp float;
uniform sampler2D uTex;
${needsTime ? 'uniform float uT;\n' : ''}in vec2 vUv;
out vec4 outColor;
${hasGrain ? PCG_GLSL + '\n' : ''}void main() {`;
  if (pass.kind === 'pointwise') {
    if (pass.steps.length === 0) {
      return `${head}
  outColor = texture(uTex, ${remapExpr(extraction, 'vUv')});
}`;
    }
    const body = pass.steps.map((s) => glslify(stepBody(s, inputSize, GLSL_SYN))).join('\n');
    return `${head}
  vec4 c = texture(uTex, ${remapExpr(extraction, 'vUv')});
  float A = max(c.a, 1e-6);
  vec3 s = c.rgb / A;
${body}
  outColor = vec4(s * c.a, c.a);
}`;
  }
  if (pass.kind === 'blur') {
    return `${head}
${blurBodyGlsl(pass.axis, pass.radius, inputSize)}
}`;
  }
  // pixelate: snap to the center texel of each block (nearest sample —
  // blocks are exactly uniform, which the smoke oracle asserts)
  return `${head}
  vec2 ts = vec2(${f(inputSize.w)}, ${f(inputSize.h)});
  vec2 p = (floor(vUv * ts / ${f(pass.size)}) + 0.5) * ${f(pass.size)};
  outColor = texture(uTex, (floor(p) + 0.5) / ts);
}`;
}

/** The three draws of a sharpen pass: blurX(input)→S1, blurY(S1)→S2,
 * combine(input, S2)→target. `uOrig` is the pass input, bound on unit 1. */
export function sharpenSourcesGlsl(pass: Extract<FilterPass, { kind: 'sharpen' }>, inputSize: Geometry): { blurX: string; blurY: string; combine: string } {
  const head = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() {`;
  return {
    blurX: `${head}\n${blurBodyGlsl('x', pass.radius, inputSize)}\n}`,
    blurY: `${head}\n${blurBodyGlsl('y', pass.radius, inputSize)}\n}`,
    combine: `#version 300 es
precision highp float;
uniform sampler2D uTex;   // blurred
uniform sampler2D uOrig;  // pass input
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 b = texture(uTex, vUv);
  vec4 o = texture(uOrig, vUv);
  vec3 rgb = clamp(o.rgb + ${f(pass.amount)} * (o.rgb - b.rgb), vec3(0.0), vec3(o.a));
  outColor = vec4(rgb, o.a);
}`,
  };
}

// ---------------------------------------------------------------------------
// WGSL (webgpu)
// ---------------------------------------------------------------------------

// NOTE the y flip: WebGPU NDC y=+1 is texture ROW 0 (GL is the opposite), so
// uv.y=0 must land at NDC +1 for each pass to be orientation-identity. The
// GLSL twin (FILTER_VS_GLSL) maps uv directly — GL framebuffer row 0 sits at
// NDC y=−1.
const WGSL_VS = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var quad = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  let uv = quad[vi];
  var out: VSOut;
  out.pos = vec4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.uv = uv;
  return out;
}`;

const blurBodyWgsl = (axis: 'x' | 'y', radius: number, inputSize: Geometry, sample: (uv: string) => string): string => {
  const R = blurTaps(radius);
  const inv2s2 = -1 / (2 * radius * radius);
  const px = axis === 'x' ? `vec2(${f(1 / inputSize.w)}, 0.0)` : `vec2(0.0, ${f(1 / inputSize.h)})`;
  return `  let px = ${px};
  var acc = vec4(0.0);
  var wsum = 0.0;
  for (var i = -${R}; i <= ${R}; i++) {
    let w = exp(f32(i * i) * ${f(inv2s2)});
    acc += w * ${sample('in.uv + f32(i) * px')};
    wsum += w;
  }
  return acc / wsum;`;
};

/**
 * Full WGSL module (vertex + fragment) for one pass. `external` selects the
 * texture_external flavor — only legal on pass 0 of a video layer's chain
 * (imported external textures are valid for a single frame, so the chain
 * always begins by resolving the source into a plain texture). Passes that
 * need time declare `struct U { t: f32 }` at binding 2.
 */
export function passModuleWgsl(
  pass: FilterPass, inputSize: Geometry, extraction: Extraction | null, external: boolean,
): string {
  if (pass.kind === 'sharpen') throw new Error('sharpen expands via sharpenModulesWgsl');
  if (external && pass.kind !== 'pointwise') throw new Error('external texture is only legal on the pass-0 pointwise draw');
  const decl = external ? 'texture_external' : 'texture_2d<f32>';
  // textureSampleLevel avoids implicit-derivative uniformity constraints
  // (blur samples inside a loop); external textures have exactly one sampler
  const sample = (uv: string) => external
    ? `textureSampleBaseClampToEdge(tex, samp, ${uv})`
    : `textureSampleLevel(tex, samp, ${uv}, 0.0)`;
  const needsTime = passNeedsTime(pass);
  const hasGrain = pass.kind === 'pointwise' && pass.steps.some((s) => s.op === 'grain');
  const head = `${WGSL_VS}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: ${decl};
${needsTime ? 'struct U { t: f32 }\n@group(0) @binding(2) var<uniform> uni: U;\n' : ''}${hasGrain ? PCG_WGSL + '\n' : ''}@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {`;
  if (pass.kind === 'pointwise') {
    if (pass.steps.length === 0) {
      return `${head}
  return ${sample(remapExpr(extraction, 'in.uv'))};
}`;
    }
    const body = pass.steps.map((s) => stepBody(s, inputSize, WGSL_SYN)).join('\n');
    return `${head}
  let c = ${sample(remapExpr(extraction, 'in.uv'))};
  let A = max(c.a, 1e-6);
  var s = c.rgb / A;
${body}
  return vec4(s * c.a, c.a);
}`;
  }
  if (pass.kind === 'blur') {
    return `${head}
${blurBodyWgsl(pass.axis, pass.radius, inputSize, sample)}
}`;
  }
  return `${head}
  let ts = vec2(${f(inputSize.w)}, ${f(inputSize.h)});
  let p = (floor(in.uv * ts / ${f(pass.size)}) + 0.5) * ${f(pass.size)};
  return ${sample('(floor(p) + 0.5) / ts')};
}`;
}

/** WGSL twins of sharpenSourcesGlsl — `orig` is the pass input at binding 2. */
export function sharpenModulesWgsl(pass: Extract<FilterPass, { kind: 'sharpen' }>, inputSize: Geometry): { blurX: string; blurY: string; combine: string } {
  const head = `${WGSL_VS}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {`;
  const sample = (uv: string) => `textureSampleLevel(tex, samp, ${uv}, 0.0)`;
  return {
    blurX: `${head}\n${blurBodyWgsl('x', pass.radius, inputSize, sample)}\n}`,
    blurY: `${head}\n${blurBodyWgsl('y', pass.radius, inputSize, sample)}\n}`,
    combine: `${WGSL_VS}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var orig: texture_2d<f32>;
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let b = textureSampleLevel(tex, samp, in.uv, 0.0);
  let o = textureSampleLevel(orig, samp, in.uv, 0.0);
  let rgb = clamp(o.rgb + ${f(pass.amount)} * (o.rgb - b.rgb), vec3(0.0), vec3(o.a));
  return vec4(rgb, o.a);
}`,
  };
}
