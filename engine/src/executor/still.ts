/**
 * Still lane — single-frame extraction [D7]. No muxer, no span loop: pick the
 * span containing the requested output time, random-access-decode each
 * binding's frame (VideoSampleSink.getSample), render the span's composite
 * once, and encode the canvas via OffscreenCanvas.convertToBlob.
 *
 * Reuses the exact composite/ramps the video lane would have used at that
 * instant, so a still is pixel-consistent with the rendered video.
 */

import type { CompiledPlan, FrameTransform, Geometry, ParamRamp, Sec } from '../schema';
import { createRenderer } from '../render/index';
import { videoSinkFor, type AssetIO } from './assets';
import { CaptionRasterizer } from './captions';
import type { Backend } from '../schema';

const rampAt = (r: ParamRamp, t: Sec): number => {
  const [t0, t1] = r.over;
  if (t <= t0) return r.from;
  if (t >= t1) return r.to;
  return r.from + ((t - t0) / (t1 - t0)) * (r.to - r.from);
};

export async function runStill(
  plan: CompiledPlan,
  io: AssetIO,
  backend: Backend | 'auto',
  kernel?: FrameTransform | null,
): Promise<Blob> {
  const still = plan.still!;
  const t = still.time;
  const span = plan.spans.find((s) => s.start <= t && t < s.end) ?? plan.spans[plan.spans.length - 1];
  if (!span?.video) throw new Error(`no video span at output time ${t}s`);
  const lane = span.video;

  const statics = new Map<number, ImageBitmap>();
  const inputGeoms = new Map<number, Geometry>();
  lane.bindings.forEach((b) => {
    const g = io.get(b.asset).geometry;
    if (g) inputGeoms.set(b.slot, g);
  });
  for (const [slot, assetId] of Object.entries(lane.staticSlots ?? {})) {
    const asset = io.get(assetId);
    if (!asset.bitmap) throw new Error(`asset '${asset.label}' is not an image`);
    statics.set(Number(slot), asset.bitmap);
    inputGeoms.set(Number(slot), asset.geometry!);
  }
  for (const slot of Object.keys(lane.captionSlots ?? {})) {
    inputGeoms.set(Number(slot), lane.composite.canvas);
  }
  // stills render transparent so uncovered/alpha pixels survive to the png
  // (transformImage artifacts, transparent watermarks); jpeg flattens over
  // white at encode [G3]
  const renderer = await createRenderer(backend, { spec: lane.composite, inputGeoms, statics, transparent: true });

  try {
    const vf = new Map<number, VideoFrame>();
    const samples = await Promise.all(lane.bindings.map(async (b) => {
      // invert the binding's time map: t_src = (t_out - offset) * rate
      const tSrc = (t - b.offset) * (b.rate ?? 1);
      const asset = io.get(b.asset);
      const sink = videoSinkFor(asset);
      let sample = await sink.getSample(tSrc);
      if (!sample && asset.video) {
        // random access outside the track's actual frame range: webm streams
        // often START after 0, and container duration can outrun the last
        // frame — clamp to the real range and answer with the edge frame
        const first = await asset.video.getFirstTimestamp();
        const last = await asset.video.computeDuration();
        sample = await sink.getSample(Math.min(Math.max(tSrc, first), Math.max(first, last - 1e-3)));
      }
      if (!sample) throw new Error(`asset '${asset.label}' has no frame at source time ${tSrc}s`);
      return { slot: b.slot, sample };
    }));
    for (const { slot, sample } of samples) vf.set(slot, sample.toVideoFrame());

    // burn-in captions [O5] at the still instant
    for (const [slot, spec] of Object.entries(lane.captionSlots ?? {})) {
      const asset = io.get(spec.asset);
      if (asset.text == null) throw new Error(`asset '${asset.label}' is not timed-text`);
      const r = new CaptionRasterizer(lane.composite.canvas, spec, asset.text);
      await r.ready();
      const cf = r.frameAt(t);
      if (cf) vf.set(Number(slot), cf);
    }

    let opacities: (number | null)[] | undefined;
    if (lane.opacityRamps) {
      opacities = [];
      for (const [layerIdx, ramp] of Object.entries(lane.opacityRamps)) {
        opacities[Number(layerIdx)] = rampAt(ramp, t);
      }
    }
    renderer.render(vf, opacities, t);
    for (const f of vf.values()) f.close();
    for (const { sample } of samples) sample.close();

    const type = plan.output.container === 'png' ? 'image/png' : 'image/jpeg';
    const opts = still.quality !== undefined ? { type, quality: still.quality } : { type };
    // [G3] jpeg has no alpha: flatten over white (same rule as the pipeline's
    // delivery edge), never over the renderer's clear color
    const encode = async (src: OffscreenCanvas): Promise<Blob> => {
      if (plan.output.container !== 'jpeg') return src.convertToBlob(opts);
      const flat = new OffscreenCanvas(src.width, src.height);
      const c2d = flat.getContext('2d')!;
      c2d.fillStyle = '#ffffff';
      c2d.fillRect(0, 0, src.width, src.height);
      c2d.drawImage(src, 0, 0);
      return flat.convertToBlob(opts);
    };
    if (kernel) {
      // model kernel [U3]: composed frame → kernel → encode at plan.canvas
      const composed = new VideoFrame(renderer.canvas, { timestamp: Math.round(t * 1e6) });
      const out = await kernel(composed, t);
      if (out !== composed) composed.close();
      const target = new OffscreenCanvas(plan.canvas.w, plan.canvas.h);
      target.getContext('2d')!.drawImage(out as unknown as CanvasImageSource, 0, 0, plan.canvas.w, plan.canvas.h);
      out.close();
      return await encode(target);
    }
    return await encode(renderer.canvas);
  } finally {
    renderer.destroy();
  }
}
