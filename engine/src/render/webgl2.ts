/**
 * WebGL2 interpreter of the CompositeSpec — same semantics as the WebGPU
 * renderer, same vertex math, same premultiplied-alpha policy. Differences
 * are mechanical: video frames are uploaded per frame via texImage2D (no
 * external-texture import in WebGL), uniforms are plain uniform calls, and
 * the quad comes from gl_VertexID.
 *
 * Filter chains (docs/filters-gpu-plan.md §4): a layer with `filters` runs
 * its planned passes source → ping-pong FBOs at srcRect resolution before
 * the composite draw (which then samples the final intermediate whole);
 * `postFilters` re-target the composite into an intermediate and run at
 * canvas resolution, last pass to the default framebuffer. Static layers
 * filter ONCE at init. Pass parameters are baked into generated shaders —
 * passes bind exactly one texture and nothing else.
 */

import type { Backend, FilterStep, Geometry } from '../schema';
import type { CompositeRenderer, RendererInit } from './types';
import {
  FILTER_VS_GLSL, passFragmentGlsl, passNeedsTime, planFilterPasses,
  sharpenSourcesGlsl, type Extraction,
} from './filters';

const VS = /* glsl */ `#version 300 es
precision highp float;
uniform mat3 uTransform;      // srcRect-local px -> canvas px
uniform vec4 uMisc;           // x: opacity, y: srcRect w px, z: srcRect h px
uniform vec2 uCanvas;
out vec2 vUv;
void main() {
  vec2 quad[6] = vec2[6](
    vec2(0.,0.), vec2(1.,0.), vec2(0.,1.),
    vec2(1.,0.), vec2(1.,1.), vec2(0.,1.));
  vec2 uv = quad[gl_VertexID];
  vec2 local = uv * uMisc.yz;
  vec2 p = (uTransform * vec3(local, 1.0)).xy;
  vec2 ndc = vec2(2.0 * p.x / uCanvas.x - 1.0, 1.0 - 2.0 * p.y / uCanvas.y);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vUv = uv;
}`;

const FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec4 uSrcRectNorm;
uniform vec4 uMisc;
uniform mat3 uColorMat;       // fused lighting matrix (identity default)
uniform vec3 uColorOffset;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 suv = uSrcRectNorm.xy + vUv * uSrcRectNorm.zw;
  vec4 c = texture(uTex, suv);
  // straight-color transform, exact for premultiplied inputs (same as WGSL)
  vec3 rgb = clamp(uColorMat * c.rgb + uColorOffset * c.a, vec3(0.0), vec3(c.a));
  outColor = vec4(rgb, c.a) * uMisc.x;   // premultiplied convention
}`;

type RigPass =
  | { kind: 'draw'; program: WebGLProgram; timeLoc: WebGLUniformLocation | null }
  /** Three draws: blurX(input)→S1, blurY(S1)→S2, combine(S2, input)→target. */
  | { kind: 'sharpen'; blurX: WebGLProgram; blurY: WebGLProgram; combine: WebGLProgram };

/** Per-layer (or post-composite) filter pass chain: programs + two ping-pong
 * render targets (+ two scratch targets when sharpen needs the pass input
 * alive). `out` is whichever texture holds the final pass's result. */
interface FilterRig {
  passes: RigPass[];
  tex: [WebGLTexture, WebGLTexture];
  fbo: [WebGLFramebuffer, WebGLFramebuffer];
  scratch: { tex: [WebGLTexture, WebGLTexture]; fbo: [WebGLFramebuffer, WebGLFramebuffer] } | null;
  w: number;
  h: number;
  out: WebGLTexture;
}

interface LayerState {
  transform: Float32Array;   // mat3, column-major
  srcRectNorm: [number, number, number, number];
  misc: [number, number, number, number];
  colorMat: Float32Array;    // mat3, column-major
  colorOffset: [number, number, number];
  texture: WebGLTexture;
  isStatic: boolean;
  rig?: FilterRig;
}

export async function createWebGL2Renderer(init: RendererInit): Promise<CompositeRenderer> {
  const { spec, inputGeoms, statics, transparent } = init;
  const canvas = new OffscreenCanvas(spec.canvas.w, spec.canvas.h);
  const gl = canvas.getContext('webgl2', {
    // transparent stills keep the alpha channel; the canvas is interpreted
    // as premultiplied (our pipeline's native representation)
    alpha: !!transparent,
    premultipliedAlpha: true,
    antialias: false,
    // our capture pattern reads the canvas right after draw, same task
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('no webgl2 context');

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(`shader compile: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  };
  const link = (vs: WebGLShader, fsSrc: string) => {
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  };
  const compositeVS = compile(gl.VERTEX_SHADER, VS);
  const program = link(compositeVS, FS);
  gl.useProgram(program);
  const loc = {
    transform: gl.getUniformLocation(program, 'uTransform'),
    misc: gl.getUniformLocation(program, 'uMisc'),
    canvas: gl.getUniformLocation(program, 'uCanvas'),
    srcRectNorm: gl.getUniformLocation(program, 'uSrcRectNorm'),
    colorMat: gl.getUniformLocation(program, 'uColorMat'),
    colorOffset: gl.getUniformLocation(program, 'uColorOffset'),
    tex: gl.getUniformLocation(program, 'uTex'),
  };
  gl.uniform1i(loc.tex, 0);
  gl.uniform2f(loc.canvas, spec.canvas.w, spec.canvas.h);

  gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied

  const mkTexture = (w?: number, h?: number) => {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w !== undefined && h !== undefined) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    return tex;
  };
  const filterVS = compile(gl.VERTEX_SHADER, FILTER_VS_GLSL);
  let sharedVSUsed = false;

  const mkRig = (filters: FilterStep[], size: Geometry, extraction: Extraction | null): FilterRig => {
    sharedVSUsed = true;
    const planned = planFilterPasses(filters);
    const linkPass = (fsSrc: string, orig = false) => {
      const prog = link(filterVS, fsSrc);
      gl.useProgram(prog);
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
      if (orig) gl.uniform1i(gl.getUniformLocation(prog, 'uOrig'), 1);
      return prog;
    };
    const passes: RigPass[] = planned.map((p, i) => {
      if (p.kind === 'sharpen') {
        const src = sharpenSourcesGlsl(p, size);
        return {
          kind: 'sharpen',
          blurX: linkPass(src.blurX), blurY: linkPass(src.blurY),
          combine: linkPass(src.combine, true),
        };
      }
      const program = linkPass(passFragmentGlsl(p, size, i === 0 ? extraction : null));
      return {
        kind: 'draw', program,
        timeLoc: passNeedsTime(p) ? gl.getUniformLocation(program, 'uT') : null,
      };
    });
    const mk = (): [WebGLTexture, WebGLFramebuffer] => {
      const tex = mkTexture(size.w, size.h);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return [tex, fbo];
    };
    const [texA, fboA] = mk();
    const [texB, fboB] = mk();
    let scratch: FilterRig['scratch'] = null;
    if (planned.some((p) => p.kind === 'sharpen')) {
      const [s0t, s0f] = mk();
      const [s1t, s1f] = mk();
      scratch = { tex: [s0t, s1t], fbo: [s0f, s1f] };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return {
      passes, tex: [texA, texB], fbo: [fboA, fboB], scratch,
      w: size.w, h: size.h,
      out: planned.length % 2 === 1 ? texA : texB,
    };
  };

  /** Run a rig: `source` → passes → rig.out. Leaves blend disabled and the
   * default framebuffer unbound; callers restore composite state after. */
  const runRig = (rig: FilterRig, source: WebGLTexture, t: number, toScreen = false) => {
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    let input = source;
    const bindTarget = (i: number, last: boolean) => {
      if (toScreen && last) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, spec.canvas.w, spec.canvas.h);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, rig.fbo[i % 2]!);
        gl.viewport(0, 0, rig.w, rig.h);
      }
    };
    rig.passes.forEach((p, i) => {
      const last = i === rig.passes.length - 1;
      if (p.kind === 'sharpen') {
        const s = rig.scratch!;
        gl.viewport(0, 0, rig.w, rig.h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo[0]!);
        gl.useProgram(p.blurX);
        gl.bindTexture(gl.TEXTURE_2D, input);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo[1]!);
        gl.useProgram(p.blurY);
        gl.bindTexture(gl.TEXTURE_2D, s.tex[0]!);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        bindTarget(i, last);
        gl.useProgram(p.combine);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, input);       // uOrig: the pass input
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, s.tex[1]!);   // uTex: blurred
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      } else {
        bindTarget(i, last);
        gl.useProgram(p.program);
        if (p.timeLoc) gl.uniform1f(p.timeLoc, t);
        gl.bindTexture(gl.TEXTURE_2D, input);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      input = rig.tex[i % 2]!;
    });
  };

  const layers: LayerState[] = spec.layers.map((layer) => {
    const g = inputGeoms.get(layer.input);
    if (!g) throw new Error(`no geometry for input slot ${layer.input}`);
    const [a, b, c, d, e, f] = layer.transform;
    const texture = mkTexture();
    const staticBitmap = statics?.get(layer.input);
    if (staticBitmap) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // bitmaps arrive straight
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, staticBitmap);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    const m = layer.color?.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    let rig: FilterRig | undefined;
    if (layer.filters?.length) {
      const size = { w: Math.max(1, Math.round(layer.srcRect.w)), h: Math.max(1, Math.round(layer.srcRect.h)) };
      rig = mkRig(layer.filters, size, { srcRect: layer.srcRect, source: g });
      if (staticBitmap) runRig(rig, texture, 0); // statics filter once
    }
    return {
      // column-major mat3 from row-major affine
      transform: new Float32Array([a, d, 0, b, e, 0, c, f, 1]),
      // filtered layers sample their final intermediate whole — the
      // extraction remap already consumed srcRect
      srcRectNorm: rig ? [0, 0, 1, 1]
        : [layer.srcRect.x / g.w, layer.srcRect.y / g.h, layer.srcRect.w / g.w, layer.srcRect.h / g.h],
      misc: [layer.opacity, layer.srcRect.w, layer.srcRect.h, 0],
      colorMat: new Float32Array([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]),
      colorOffset: layer.color?.offset ?? [0, 0, 0],
      texture,
      isStatic: !!staticBitmap,
      ...(rig ? { rig } : {}),
    };
  });

  // post-composite chain: composite draws into an intermediate, passes run at
  // canvas resolution, last pass lands on the default framebuffer
  let post: { src: WebGLTexture; fbo: WebGLFramebuffer; rig: FilterRig } | null = null;
  if (spec.postFilters?.length) {
    const src = mkTexture(spec.canvas.w, spec.canvas.h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    post = { src, fbo, rig: mkRig(spec.postFilters, { w: spec.canvas.w, h: spec.canvas.h }, null) };
  }
  if (!sharedVSUsed) gl.deleteShader(filterVS);

  return {
    backend: 'webgl2' as Backend,
    canvas,
    render(frames, opacities, t = 0) {
      // per-layer filter passes first (they rebind framebuffers/programs)
      gl.activeTexture(gl.TEXTURE0);
      for (const [li, ls] of layers.entries()) {
        if (!ls.rig || ls.isStatic) continue;
        const frame = frames.get(spec.layers[li]!.input);
        if (!frame) continue;
        gl.bindTexture(gl.TEXTURE_2D, ls.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        runRig(ls.rig, ls.texture, t);
      }

      // composite
      gl.bindFramebuffer(gl.FRAMEBUFFER, post ? post.fbo : null);
      gl.viewport(0, 0, spec.canvas.w, spec.canvas.h);
      gl.useProgram(program);
      gl.enable(gl.BLEND);
      gl.clearColor(0, 0, 0, transparent ? 0 : 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      layers.forEach((ls, li) => {
        const layer = spec.layers[li]!;
        if (!ls.isStatic && !frames.has(layer.input)) return; // slot not yet available — skip
        gl.activeTexture(gl.TEXTURE0);
        if (ls.rig) {
          gl.bindTexture(gl.TEXTURE_2D, ls.rig.out); // filled by the pre-pass above
        } else {
          gl.bindTexture(gl.TEXTURE_2D, ls.texture);
          if (!ls.isStatic) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frames.get(layer.input)!);
          }
        }
        const o = opacities?.[li];
        if (o != null) ls.misc[0] = o;
        gl.uniformMatrix3fv(loc.transform, false, ls.transform);
        gl.uniform4f(loc.srcRectNorm, ...ls.srcRectNorm);
        gl.uniform4f(loc.misc, ls.misc[0], ls.misc[1], ls.misc[2], ls.misc[3]);
        gl.uniformMatrix3fv(loc.colorMat, false, ls.colorMat);
        gl.uniform3f(loc.colorOffset, ...ls.colorOffset);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      });

      if (post) runRig(post.rig, post.src, t, /* toScreen */ true);
    },
    destroy() {
      const rigs = [...layers.map((l) => l.rig), post?.rig].filter((r): r is FilterRig => !!r);
      for (const r of rigs) {
        for (const p of r.passes) {
          if (p.kind === 'sharpen') { gl.deleteProgram(p.blurX); gl.deleteProgram(p.blurY); gl.deleteProgram(p.combine); }
          else gl.deleteProgram(p.program);
        }
        for (const t of r.tex) gl.deleteTexture(t);
        for (const f of r.fbo) gl.deleteFramebuffer(f);
        if (r.scratch) {
          for (const t of r.scratch.tex) gl.deleteTexture(t);
          for (const f of r.scratch.fbo) gl.deleteFramebuffer(f);
        }
      }
      if (post) { gl.deleteTexture(post.src); gl.deleteFramebuffer(post.fbo); }
      for (const ls of layers) gl.deleteTexture(ls.texture);
      gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
