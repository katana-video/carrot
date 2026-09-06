/**
 * WebGPU interpreter of the CompositeSpec — one uber-shader, two pipeline
 * variants (texture_external for video slots via per-frame
 * importExternalTexture; texture_2d for premultiplied static images).
 *
 * Filter chains (docs/filters-gpu-plan.md §4): a layer with `filters` runs
 * its planned passes in the same command encoder BEFORE the composite pass —
 * pass 0 resolves the source (external texture for video, imported once per
 * frame; the uploaded bitmap for statics, run ONCE at init) into an
 * intermediate, later passes ping-pong; the composite then samples the final
 * intermediate through the texture_2d pipeline. `postFilters` re-target the
 * composite into an intermediate and run at canvas resolution, last pass onto
 * the swapchain view. Pass parameters are baked into generated WGSL — passes
 * bind exactly one sampler + one texture.
 */

import type { Backend, FilterStep, Geometry } from '../schema';
import type { CompositeRenderer, RendererInit } from './types';
import {
  passModuleWgsl, passNeedsTime, planFilterPasses, sharpenModulesWgsl,
  type Extraction, type FilterPass,
} from './filters';

const WGSL = (textureDecl: string, sampleExpr: string) => /* wgsl */ `
struct LayerU {
  transform: mat3x3<f32>,   // srcRect-local px -> canvas px (column-major)
  srcRectNorm: vec4<f32>,   // normalized in source texture
  misc: vec4<f32>,          // x: opacity, y: srcRect w px, z: srcRect h px
  canvas: vec4<f32>,
  colorMat: mat3x3<f32>,    // fused lighting matrix (identity default)
  colorOffset: vec4<f32>,
};
@group(0) @binding(0) var<uniform> u: LayerU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: ${textureDecl};

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var quad = array<vec2<f32>, 6>(
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
  let uv = quad[vi];
  let local = uv * u.misc.yz;
  let p = (u.transform * vec3(local, 1.0)).xy;
  let ndc = vec2(2.0 * p.x / u.canvas.x - 1.0, 1.0 - 2.0 * p.y / u.canvas.y);
  var out: VSOut;
  out.pos = vec4(ndc, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let suv = u.srcRectNorm.xy + in.uv * u.srcRectNorm.zw;
  let c = ${sampleExpr};
  // Color transform on straight color, exact for premultiplied inputs:
  // s' = M*s + o (straight)  ⇔  c' = M*c + o*a (premultiplied); clamp keeps
  // the premultiplied invariant rgb <= a. Identity when no lighting effects.
  let rgb = clamp(u.colorMat * c.rgb + u.colorOffset.rgb * c.a, vec3(0.0), vec3(c.a));
  // Premultiplied convention: scale the whole (premultiplied) color by opacity.
  // Video external samples are opaque (a=1) so this is exact for them too.
  return vec4(rgb, c.a) * u.misc.x;
}`;

let sharedDevice: Promise<GPUDevice> | null = null;

/** One device per page/worker context; renderers share it. */
export function getWebGPUDevice(): Promise<GPUDevice> {
  sharedDevice ??= (async () => {
    if (!navigator.gpu) throw new Error('WebGPU not available');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    device.lost.then((info) => {
      sharedDevice = null;
      if (info.reason !== 'destroyed') console.error('GPU device lost:', info.message);
    });
    return device;
  })();
  return sharedDevice;
}

const INTERMEDIATE: GPUTextureFormat = 'rgba8unorm';

type GpuRigPass =
  /** bindGroup is null for a per-frame external pass 0 (built at import time;
   * needsTime tells the per-frame path to include the time buffer). */
  | { kind: 'draw'; pipeline: GPURenderPipeline; bindGroup: GPUBindGroup | null; needsTime: boolean }
  /** Three draws: blurX(input)→S1, blurY(S1)→S2, combine(S2, input)→target.
   * All bind groups are cacheable — sharpen is never pass 0. */
  | { kind: 'sharpen'; draws: [
      { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup },
      { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup },
      { pipeline: GPURenderPipeline; bindGroup: GPUBindGroup },
    ] };

/** Filter pass chain: pipelines + ping-pong targets. */
interface GpuRig {
  passes: GpuRigPass[];
  tex: [GPUTexture, GPUTexture];
  views: [GPUTextureView, GPUTextureView];
  /** Scratch targets for sharpen's intermediate blurs. */
  scratch: { tex: [GPUTexture, GPUTexture]; views: [GPUTextureView, GPUTextureView] } | null;
  /** Written per frame when a pass needs the grain time seed. */
  timeBuf: GPUBuffer | null;
  /** Texture holding the final result (parity of the pass count). */
  out: GPUTexture;
  external: boolean;
}

export async function createWebGPURenderer(init: RendererInit): Promise<CompositeRenderer> {
  const { spec, inputGeoms, statics, transparent } = init;
  const device = await getWebGPUDevice();

  const canvas = new OffscreenCanvas(spec.canvas.w, spec.canvas.h);
  const ctx = canvas.getContext('webgpu');
  if (!ctx) throw new Error('no webgpu context on OffscreenCanvas');
  const format = navigator.gpu.getPreferredCanvasFormat();
  // transparent stills keep alpha; 'premultiplied' matches the pipeline's
  // native representation (video encode stays opaque)
  ctx.configure({ device, format, alphaMode: transparent ? 'premultiplied' : 'opaque' });
  const clearA = transparent ? 0 : 1;

  const hasPost = !!spec.postFilters?.length;
  /** With postFilters the composite lands in an intermediate, not the canvas. */
  const compositeFormat: GPUTextureFormat = hasPost ? INTERMEDIATE : format;

  const blend: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },   // premultiplied
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  };
  const mkPipeline = (decl: string, sample: string) => {
    const module = device.createShaderModule({ code: WGSL(decl, sample) });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: compositeFormat, blend }] },
      primitive: { topology: 'triangle-list' },
    });
  };
  const extPipeline = mkPipeline('texture_external', 'textureSampleBaseClampToEdge(tex, samp, suv)');
  const staticPipeline = mkPipeline('texture_2d<f32>', 'textureSample(tex, samp, suv)');
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  /** Every rig ever built (incl. one-shot static rigs) — destroy() sweeps. */
  const allRigs: GpuRig[] = [];
  const mkTarget = (g: Geometry) => device.createTexture({
    size: [g.w, g.h], format: INTERMEDIATE,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const passBindGroup = (pipeline: GPURenderPipeline, tex: GPUTextureView | GPUExternalTexture) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: tex },
      ],
    });

  /** Build a rig. `source` is the pass-0 input for non-external chains
   * (static bitmaps, the post-composite intermediate); external chains build
   * pass 0's bind group per frame at import time. `finalFormat` differs from
   * INTERMEDIATE only for a post chain's last pass (the swapchain format). */
  const mkRig = (
    filters: FilterStep[], size: Geometry, extraction: Extraction | null,
    opts: { external?: boolean; source?: GPUTextureView; finalFormat?: GPUTextureFormat } = {},
  ): GpuRig => {
    const planned = planFilterPasses(filters);
    const texA = mkTarget(size);
    const texB = mkTarget(size);
    const views: [GPUTextureView, GPUTextureView] = [texA.createView(), texB.createView()];
    let scratch: GpuRig['scratch'] = null;
    if (planned.some((p) => p.kind === 'sharpen')) {
      const s0 = mkTarget(size), s1 = mkTarget(size);
      scratch = { tex: [s0, s1], views: [s0.createView(), s1.createView()] };
    }
    const timeBuf = planned.some(passNeedsTime)
      ? device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      : null;
    const mkModulePipeline = (code: string, target: GPUTextureFormat) => {
      const module = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: target }] }, // no blend: full-quad copies
        primitive: { topology: 'triangle-list' },
      });
    };
    const passes: GpuRigPass[] = planned.map((p, i) => {
      const last = i === planned.length - 1;
      const finalFmt = last && opts.finalFormat ? opts.finalFormat : INTERMEDIATE;
      // planner guarantees pass 0 is pointwise, so i>0 inputs are ping-pong
      const input = (): GPUTextureView => i === 0 ? opts.source! : views[(i - 1) % 2]!;
      if (p.kind === 'sharpen') {
        const src = sharpenModulesWgsl(p, size);
        const pX = mkModulePipeline(src.blurX, INTERMEDIATE);
        const pY = mkModulePipeline(src.blurY, INTERMEDIATE);
        const pC = mkModulePipeline(src.combine, finalFmt);
        return {
          kind: 'sharpen',
          draws: [
            { pipeline: pX, bindGroup: passBindGroup(pX, input()) },
            { pipeline: pY, bindGroup: passBindGroup(pY, scratch!.views[0]!) },
            { pipeline: pC, bindGroup: device.createBindGroup({
                layout: pC.getBindGroupLayout(0),
                entries: [
                  { binding: 0, resource: sampler },
                  { binding: 1, resource: scratch!.views[1]! },  // blurred
                  { binding: 2, resource: input() },             // orig
                ],
              }) },
          ],
        };
      }
      const external = !!opts.external && i === 0;
      const pipeline = mkModulePipeline(passModuleWgsl(p, size, i === 0 ? extraction : null, external), finalFmt);
      let bindGroup: GPUBindGroup | null = null;
      if (!external) {
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: sampler },
          { binding: 1, resource: input() },
        ];
        if (passNeedsTime(p)) entries.push({ binding: 2, resource: { buffer: timeBuf! } });
        bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      }
      return { kind: 'draw', pipeline, bindGroup, needsTime: passNeedsTime(p) };
    });
    const rig: GpuRig = {
      passes, tex: [texA, texB], views, scratch, timeBuf,
      out: planned.length % 2 === 1 ? texA : texB,
      external: !!opts.external,
    };
    allRigs.push(rig);
    return rig;
  };

  const runPass = (encoder: GPUCommandEncoder, view: GPUTextureView, pipeline: GPURenderPipeline, bindGroup: GPUBindGroup) => {
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: clearA }, storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
  };

  /** Encode a rig's passes. `externalTex` feeds an external pass 0;
   * `finalTarget` (post chains) redirects the last pass off the ping-pong. */
  const encodeRig = (
    encoder: GPUCommandEncoder, rig: GpuRig,
    externalTex: GPUExternalTexture | null, finalTarget: GPUTextureView | null,
  ) => {
    rig.passes.forEach((p, i) => {
      const last = i === rig.passes.length - 1;
      const target = last && finalTarget ? finalTarget : rig.views[i % 2]!;
      if (p.kind === 'sharpen') {
        runPass(encoder, rig.scratch!.views[0]!, p.draws[0].pipeline, p.draws[0].bindGroup);
        runPass(encoder, rig.scratch!.views[1]!, p.draws[1].pipeline, p.draws[1].bindGroup);
        runPass(encoder, target, p.draws[2].pipeline, p.draws[2].bindGroup);
      } else {
        let bg = p.bindGroup;
        if (!bg) { // external pass 0, built at import time
          const entries: GPUBindGroupEntry[] = [
            { binding: 0, resource: sampler },
            { binding: 1, resource: externalTex! },
          ];
          if (p.needsTime) entries.push({ binding: 2, resource: { buffer: rig.timeBuf! } });
          bg = device.createBindGroup({ layout: p.pipeline.getBindGroupLayout(0), entries });
        }
        runPass(encoder, target, p.pipeline, bg);
      }
    });
  };

  const miscBase: Float32Array[] = [];
  const uniforms: GPUBuffer[] = spec.layers.map((layer) => {
    const g = inputGeoms.get(layer.input);
    if (!g) throw new Error(`no geometry for input slot ${layer.input}`);
    const [a, b, c, d, e, f] = layer.transform;
    const misc = new Float32Array([layer.opacity, layer.srcRect.w, layer.srcRect.h, 0]);
    miscBase.push(misc);
    const m = layer.color?.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const o = layer.color?.offset ?? [0, 0, 0];
    // filtered layers sample their final intermediate whole — the extraction
    // remap already consumed srcRect
    const srn = layer.filters?.length
      ? [0, 0, 1, 1]
      : [layer.srcRect.x / g.w, layer.srcRect.y / g.h, layer.srcRect.w / g.w, layer.srcRect.h / g.h];
    const buf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, new Float32Array([
      a, d, 0, 0, b, e, 0, 0, c, f, 1, 0,
      srn[0]!, srn[1]!, srn[2]!, srn[3]!,
      misc[0]!, misc[1]!, misc[2]!, misc[3]!,
      spec.canvas.w, spec.canvas.h, 0, 0,
      // colorMat, row-major → column-major, 16B-aligned columns
      m[0]!, m[3]!, m[6]!, 0, m[1]!, m[4]!, m[7]!, 0, m[2]!, m[5]!, m[8]!, 0,
      o[0]!, o[1]!, o[2]!, 0,
    ]));
    return buf;
  });

  // static images upload once; layers with filters run their chain at init
  const staticTextures: GPUTexture[] = [];
  const staticBindGroups = new Map<number, GPUBindGroup>();
  /** Per-layer-index rigs for video slots (encoded every frame). */
  const videoRigs = new Map<number, GpuRig>();
  const initEncoder = device.createCommandEncoder();

  spec.layers.forEach((layer, li) => {
    const bitmap = statics?.get(layer.input);
    if (!bitmap) return;
    const tex = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    // premultipliedAlpha at copy — bitmaps arrive non-premultiplied (types.ts)
    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: tex, premultipliedAlpha: true },
      [bitmap.width, bitmap.height],
    );
    staticTextures.push(tex);
    let sampled = tex.createView();
    if (layer.filters?.length) {
      const size = { w: Math.max(1, Math.round(layer.srcRect.w)), h: Math.max(1, Math.round(layer.srcRect.h)) };
      const g = inputGeoms.get(layer.input)!;
      const rig = mkRig(layer.filters, size, { srcRect: layer.srcRect, source: g }, { source: sampled });
      encodeRig(initEncoder, rig, null, null); // statics filter once
      sampled = rig.out.createView();
    }
    staticBindGroups.set(layer.input, device.createBindGroup({
      layout: staticPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms[li]! } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: sampled },
      ],
    }));
  });

  // video layers with filters: build rigs + their (stable) composite bind groups
  const filteredVideoBindGroups = new Map<number, GPUBindGroup>();
  spec.layers.forEach((layer, li) => {
    if (!layer.filters?.length || statics?.get(layer.input)) return;
    const g = inputGeoms.get(layer.input);
    if (!g) return;
    const size = { w: Math.max(1, Math.round(layer.srcRect.w)), h: Math.max(1, Math.round(layer.srcRect.h)) };
    const rig = mkRig(layer.filters, size, { srcRect: layer.srcRect, source: g }, { external: true });
    videoRigs.set(li, rig);
    filteredVideoBindGroups.set(li, device.createBindGroup({
      layout: staticPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniforms[li]! } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: rig.out.createView() },
      ],
    }));
  });

  // post-composite chain: composite lands in `postSrc`, passes run at canvas
  // resolution, last pass targets the swapchain view (per frame)
  let post: { src: GPUTexture; srcView: GPUTextureView; rig: GpuRig } | null = null;
  if (hasPost) {
    const src = mkTarget(spec.canvas);
    const srcView = src.createView();
    post = {
      src, srcView,
      rig: mkRig(spec.postFilters!, spec.canvas, null, { source: srcView, finalFormat: format }),
    };
  }
  device.queue.submit([initEncoder.finish()]);

  return {
    backend: 'webgpu' as Backend,
    canvas,
    render(frames, opacities, t = 0) {
      for (const rig of allRigs) {
        if (rig.timeBuf) device.queue.writeBuffer(rig.timeBuf, 0, new Float32Array([t, 0, 0, 0]));
      }
      if (opacities) {
        spec.layers.forEach((_, li) => {
          const o = opacities[li];
          if (o != null && o !== miscBase[li]![0]) {
            miscBase[li]![0] = o;
            device.queue.writeBuffer(uniforms[li]!, 64, miscBase[li]!);
          }
        });
      }
      const encoder = device.createCommandEncoder();

      // per-layer filter passes (before the composite pass consumes rig.out)
      for (const [li, rig] of videoRigs) {
        const frame = frames.get(spec.layers[li]!.input);
        if (!frame) continue;
        encodeRig(encoder, rig, device.importExternalTexture({ source: frame }), null);
      }

      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: post ? post.srcView : ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: clearA },
          storeOp: 'store',
        }],
      });
      spec.layers.forEach((layer, li) => {
        const cached = staticBindGroups.get(layer.input);
        const filtered = filteredVideoBindGroups.get(li);
        if (cached) {
          pass.setPipeline(staticPipeline);
          pass.setBindGroup(0, cached);
        } else if (filtered) {
          if (!frames.get(layer.input)) return; // slot not yet available — skip
          pass.setPipeline(staticPipeline);
          pass.setBindGroup(0, filtered);
        } else {
          const frame = frames.get(layer.input);
          if (!frame) return; // slot not yet available (merge warm-up) — skip
          pass.setPipeline(extPipeline);
          pass.setBindGroup(0, device.createBindGroup({
            layout: extPipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniforms[li]! } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: device.importExternalTexture({ source: frame }) },
            ],
          }));
        }
        pass.draw(6);
      });
      pass.end();

      if (post) encodeRig(encoder, post.rig, null, ctx.getCurrentTexture().createView());
      device.queue.submit([encoder.finish()]);
    },
    destroy() {
      for (const r of allRigs) {
        r.tex[0].destroy(); r.tex[1].destroy();
        if (r.scratch) { r.scratch.tex[0].destroy(); r.scratch.tex[1].destroy(); }
        r.timeBuf?.destroy();
      }
      if (post) post.src.destroy();
      for (const buf of uniforms) buf.destroy();
      for (const tex of staticTextures) tex.destroy();
      ctx.unconfigure();
    },
  };
}
