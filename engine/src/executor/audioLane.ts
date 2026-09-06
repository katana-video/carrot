/**
 * Audio lane — slot streams (conformed to the plan's canonical format,
 * clipped sample-accurately, rebased) → gain → (mix | passthrough) → sink.
 *
 * mode 'single': streaming passthrough with optional gain ramp.
 * mode 'mix': timestamp-indexed placement over the span window with per-slot
 * gain ramps (crossfades). v0.1 limitation: mix spans buffer the span's audio
 * (fine for transitions; a long background-music mix span will want the
 * rolling-window version later — documented, not silent).
 */

import { AudioSample, type AudioSampleSource } from 'mediabunny';
import type { ParamRamp, Sec, Span } from '../schema';
import { sourceNode, sinkNode } from '../nodes/streams';
import { conformAudio, extractPlanar, planarSample, applyGain } from '../nodes/audio';
import { audioSinkFor, type AssetIO } from './assets';

const rampAt = (r: ParamRamp, t: Sec): number => {
  const [t0, t1] = r.over;
  if (t <= t0) return r.from;
  if (t >= t1) return r.to;
  return r.from + ((t - t0) / (t1 - t0)) * (r.to - r.from);
};

export interface AudioLaneCtx {
  io: AssetIO;
  audioSource: AudioSampleSource;
  rate: number;
  channels: number;
  signal: AbortSignal;
  /** Furthest output time this lane has written (progress reporting). */
  onMediaTime?: (t: number) => void;
}

export async function runAudioLane(span: Span, ctx: AudioLaneCtx): Promise<void> {
  const lane = span.audio;
  if (!lane) return;

  const slotStream = (slotIdx: number) => {
    const b = lane.bindings[slotIdx]!;
    const asset = ctx.io.get(b.asset);
    return sourceNode(audioSinkFor(asset).samples(b.sourceStart, b.sourceEnd), 8)
      .pipeThrough(conformAudio({
        rate: ctx.rate,
        channels: ctx.channels,
        windowStart: b.sourceStart,
        windowEnd: b.sourceEnd,
        offset: b.offset,
        speed: b.rate ?? 1,
      }));
  };

  if (lane.mode === 'single') {
    const ramp = lane.gainRamps?.[0];
    const gainStage = new TransformStream<AudioSample, AudioSample>({
      transform(s, controller) {
        controller.enqueue(ramp ? applyGain(s, (t) => rampAt(ramp, t)) : s);
      },
    });
    await slotStream(0)
      .pipeThrough(gainStage)
      .pipeTo(sinkNode<AudioSample>(ctx.audioSource, {
        closeSource: false,
        onWritten: (s) => ctx.onMediaTime?.(s.timestamp + s.duration),
      }), { signal: ctx.signal });
    return;
  }

  // mode 'mix' — buffered over the span window, placement by timestamp.
  const frames = Math.round((span.end - span.start) * ctx.rate);
  const mk = () => Array.from({ length: ctx.channels }, () => new Float32Array(frames));
  const mixed = mk();

  await Promise.all(lane.bindings.map(async (b, slotIdx) => {
    const ramp = lane.gainRamps?.[b.slot];
    const stream = slotStream(slotIdx);
    for await (const s of stream as unknown as AsyncIterable<AudioSample>) {
      if (ctx.signal.aborted) { s.close(); throw ctx.signal.reason; }
      const at = Math.round((s.timestamp - span.start) * ctx.rate);
      const chans = extractPlanar(s, ctx.channels);
      const t0 = s.timestamp;
      chans.forEach((ch, c) => {
        const dst = mixed[c]!;
        for (let i = 0; i < ch.length; i++) {
          const idx = at + i;
          if (idx >= 0 && idx < frames) {
            const gain = ramp ? rampAt(ramp, t0 + i / ctx.rate) : 1;
            dst[idx]! += ch[i]! * gain;
          }
        }
      });
      s.close();
    }
  }));

  for (let start = 0; start < frames; start += 1024) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const n = Math.min(1024, frames - start);
    const chans = mixed.map((ch) => ch.subarray(start, start + n));
    const sample = planarSample(chans as Float32Array[], ctx.rate, span.start + start / ctx.rate);
    await ctx.audioSource.add(sample);
    sample.close();
    ctx.onMediaTime?.(span.start + (start + n) / ctx.rate);
  }
}
