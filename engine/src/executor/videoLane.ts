/**
 * Video lane — slot streams → (merge | solo) → render stage → sink.
 * The only place the video-side graph is wired; shape comes from the plan.
 */

import { VideoSample } from 'mediabunny';
import type { ParamRamp, Sec, Span, VideoLanePlan } from '../schema';
import { sourceNode, sinkNode, gate, rebase } from '../nodes/streams';
import { mergeSlots, soloSlot, type SlotFrames } from '../nodes/mergeSlots';
import { createRenderer, type CompositeRenderer } from '../render/index';
import { videoSinkFor, type AssetIO } from './assets';
import { CaptionRasterizer } from './captions';
import type { Backend, Geometry } from '../schema';

const rampAt = (r: ParamRamp, t: Sec): number => {
  const [t0, t1] = r.over;
  if (t <= t0) return r.from;
  if (t >= t1) return r.to;
  return r.from + ((t - t0) / (t1 - t0)) * (r.to - r.from);
};

/** SlotFrames → rendered VideoSample. Closes everything it consumes. */
function renderStage(
  lane: VideoLanePlan,
  renderer: CompositeRenderer,
  captions: Map<number, CaptionRasterizer>,
  onMediaTime: (t: Sec) => void,
): TransformStream<SlotFrames, VideoSample> {
  const ramps = lane.opacityRamps;
  return new TransformStream<SlotFrames, VideoSample>({
    transform(frames, controller) {
      const primary = frames.get(0);
      if (!primary) throw new Error('render stage: no primary slot frame');
      const t = primary.timestamp;

      let opacities: (number | null)[] | undefined;
      if (ramps) {
        opacities = [];
        for (const [layerIdx, ramp] of Object.entries(ramps)) {
          opacities[Number(layerIdx)] = rampAt(ramp, t);
        }
      }

      const vf = new Map<number, VideoFrame>();
      for (const [slot, sample] of frames) vf.set(slot, sample.toVideoFrame());
      // burn-in captions [O5]: rasterized at the primary frame's timestamp
      for (const [slot, r] of captions) {
        const cf = r.frameAt(t);
        if (cf) vf.set(slot, cf);
      }
      renderer.render(vf, opacities, t);
      for (const f of vf.values()) f.close();

      const out = new VideoSample(renderer.canvas, { timestamp: t, duration: primary.duration });
      for (const sample of frames.values()) sample.close();
      onMediaTime(t + out.duration);
      controller.enqueue(out);
    },
  });
}

/** Where composed frames land: Mediabunny's VideoSampleSource, or any
 * structural equivalent (the GIF encoder node [D9]). */
export interface VideoFrameSink {
  add(sample: VideoSample, opts?: unknown): Promise<void>;
  close(): void;
}

export interface VideoLaneCtx {
  io: AssetIO;
  videoSource: VideoFrameSink;
  backend: Backend | 'auto';
  signal: AbortSignal;
  onMediaTime: (t: Sec) => void;
}

export async function runVideoLane(span: Span, canvas: Geometry, ctx: VideoLaneCtx): Promise<void> {
  const lane = span.video;
  if (!lane) return;

  // slot streams: source → boundary gate → rebase into output time
  const slotStreams = lane.bindings.map((b) => {
    const asset = ctx.io.get(b.asset);
    return sourceNode(videoSinkFor(asset).samples(b.sourceStart, b.sourceEnd), 4)
      .pipeThrough(gate<VideoSample>((s) => s.timestamp >= b.sourceStart && s.timestamp < b.sourceEnd))
      .pipeThrough(rebase<VideoSample>(b.offset, b.rate ?? 1));
  });

  // renderer for this span's composite (statics cached at AssetIO level)
  const statics = new Map<number, ImageBitmap>();
  const inputGeoms = new Map<number, Geometry>();
  lane.bindings.forEach((b) => {
    const g = ctx.io.get(b.asset).geometry;
    if (g) inputGeoms.set(b.slot, g);
  });
  for (const [slot, assetId] of Object.entries(lane.staticSlots ?? {})) {
    const asset = ctx.io.get(assetId);
    if (!asset.bitmap) throw new Error(`asset '${asset.label}' is not an image`);
    statics.set(Number(slot), asset.bitmap);
    inputGeoms.set(Number(slot), asset.geometry!);
  }
  const captions = new Map<number, CaptionRasterizer>();
  for (const [slot, spec] of Object.entries(lane.captionSlots ?? {})) {
    const asset = ctx.io.get(spec.asset);
    if (asset.text == null) throw new Error(`asset '${asset.label}' is not timed-text`);
    const r = new CaptionRasterizer(lane.composite.canvas, spec, asset.text);
    await r.ready();
    captions.set(Number(slot), r);
    inputGeoms.set(Number(slot), lane.composite.canvas);
  }
  if (lane.composite.canvas.w !== canvas.w || lane.composite.canvas.h !== canvas.h) {
    throw new Error(`span composite canvas ${lane.composite.canvas.w}x${lane.composite.canvas.h} != plan canvas ${canvas.w}x${canvas.h}`);
  }
  const renderer = await createRenderer(ctx.backend, { spec: lane.composite, inputGeoms, statics });

  if (lane.kernels?.length) {
    renderer.destroy();
    throw new Error('kernel nodes are not implemented in v0.1 executor');
  }

  // [D7b] still-base span: nothing decodes, so nothing drives the clock —
  // tick the composite at CFR instead of pulling a stream graph. Statics are
  // already renderer textures; captions rasterize per tick.
  if (!lane.bindings.length) {
    const dt = 1 / (lane.tick ?? 30);
    const ramps = lane.opacityRamps;
    let first = true;
    try {
      for (let i = 0; ; i++) {
        const t = span.start + i * dt;
        if (t >= span.end - 1e-6) break;
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException('aborted', 'AbortError');
        let opacities: (number | null)[] | undefined;
        if (ramps) {
          opacities = [];
          for (const [layerIdx, ramp] of Object.entries(ramps)) {
            opacities[Number(layerIdx)] = rampAt(ramp, t);
          }
        }
        const vf = new Map<number, VideoFrame>();
        for (const [slot, r] of captions) {
          const cf = r.frameAt(t);
          if (cf) vf.set(slot, cf);
        }
        renderer.render(vf, opacities, t);
        for (const f of vf.values()) f.close();
        const dur = Math.min(dt, span.end - t);
        const out = new VideoSample(renderer.canvas, { timestamp: t, duration: dur });
        try {
          await ctx.videoSource.add(out, first ? { keyFrame: true } : undefined);
        } finally {
          out.close();
        }
        first = false;
        ctx.onMediaTime(t + dur);
      }
    } finally {
      renderer.destroy();
    }
    return;
  }

  const upstream = slotStreams.length > 1 ? mergeSlots(slotStreams) : soloSlot(slotStreams[0]!);

  let first = true;
  try {
    await upstream
      .pipeThrough(renderStage(lane, renderer, captions, ctx.onMediaTime))
      .pipeTo(sinkNode<VideoSample>(ctx.videoSource, {
        closeSource: false,
        addOptions: () => {
          const kf = first;
          first = false;
          return kf ? { keyFrame: true } : undefined;
        },
      }), { signal: ctx.signal });
  } finally {
    renderer.destroy();
  }
}
