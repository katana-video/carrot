/**
 * CompositeRenderer — the backend seam. The CompositeSpec is backend-neutral
 * data; each backend is an interpreter of the same spec with identical
 * semantics. Cross-backend output equivalence is a test-suite invariant
 * (SSIM between webgpu and webgl2 renders of the same spec).
 *
 * Alpha policy (schema decision log): premultiplied working format. Static
 * images are uploaded premultiplied; shaders output premultiplied color
 * (sampled color × opacity) and blend with (ONE, ONE_MINUS_SRC_ALPHA).
 * Decoded video frames are opaque (a=1), so the same math covers both.
 */

import type { CompositeSpec, Geometry, Backend } from '../schema';

export interface RendererInit {
  spec: CompositeSpec;
  /** Display geometry per input slot (rotation baked — decode-exit policy). */
  inputGeoms: Map<number, Geometry>;
  /** Static images per input slot (watermarks). NON-premultiplied bitmaps;
   * renderers premultiply at upload. */
  statics?: Map<number, ImageBitmap>;
  /** Transparent output: alpha-capable canvas cleared to α=0, so uncovered
   * pixels stay transparent (the still png path — transformImage artifacts,
   * "filter this photo"). Video encoders always get the opaque default. A
   * `spec.background` overrides either default with an opaque fill. */
  transparent?: boolean;
}

export interface CompositeRenderer {
  readonly backend: Backend;
  /** The canvas encoders consume via `new VideoSample(canvas, {timestamp})`. */
  readonly canvas: OffscreenCanvas;
  /**
   * Render one output frame from the current per-slot frames. `opacities`
   * optionally overrides layer opacity for this frame (null = keep spec
   * value) — how ParamRamps animate transitions. Layers whose slot has no
   * frame yet (merge warm-up) are skipped. `t` is the output media time in
   * seconds — time-seeded filter passes (grain) consume it; renderers without
   * such passes ignore it.
   */
  render(frames: ReadonlyMap<number, VideoFrame>, opacities?: ReadonlyArray<number | null>, t?: number): void;
  /** Release GPU resources. Renderers are per-span, cheap to create;
   * explicit teardown, never GC-reliant (E2 device-loss noise). */
  destroy(): void;
}

/** Load a static image without premultiplying (renderers premultiply at
 * upload — avoids double-premultiplication). */
export function loadStaticImage(source: Blob): Promise<ImageBitmap> {
  return createImageBitmap(source, { premultiplyAlpha: 'none' });
}
