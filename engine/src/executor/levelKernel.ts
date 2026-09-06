/**
 * Adaptive audio leveling kernel [H4] — dynaudnorm-style windowed gain:
 * per-frame RMS → target gain (capped, peak-safe) → gaussian smoothing over
 * a lookahead window → per-sample gain interpolation. Evens out loud/quiet
 * speakers and mismatched clips without compressor pumping.
 *
 * Pure JS, no weights, registered by createWorkerHost on every host —
 * unlike denoise/upscale it has no external artifacts to fetch.
 */
import { z } from 'zod';
import { registerOp, getOp, type AudioStreamTransform } from '../schema';

const FRAME_S = 0.5;
/** Smoothing window in frames (odd); lookahead = half. */
const WINDOW = 15;
const LOOKAHEAD = (WINDOW - 1) / 2;
const MAX_GAIN = 10; // +20 dB
const PEAK_CEIL = 0.98;
const SILENCE_RMS = 1e-4; // ≈ −80 dBFS: hold gain, don't amplify the floor

interface Frame { data: Float32Array; frames: number; rawGain: number; peak: number }

export function makeLevelTransform(
  targetLufs: number,
  ctx: { rate: number; channels: number },
): AudioStreamTransform {
  const ch = ctx.channels;
  const frameLen = Math.round(ctx.rate * FRAME_S); // per-channel frames
  const targetRms = Math.pow(10, targetLufs / 20);

  // gaussian weights for the smoothing window
  const sigma = WINDOW / 6;
  const weights = Array.from({ length: WINDOW }, (_, i) => {
    const d = i - LOOKAHEAD;
    return Math.exp(-(d * d) / (2 * sigma * sigma));
  });

  const queue: Frame[] = [];
  let emitted = 0; // index of the next frame to emit (into rawGain history)
  let history: number[] = []; // rawGain per queued/emitted frame (aligned to queue head at `emitted`)
  let pending = new Float32Array(0);
  let lastGain = 1;

  const analyze = (data: Float32Array, frames: number): Frame => {
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      let mono = 0;
      for (let c = 0; c < ch; c++) {
        const v = data[i * ch + c]!;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        mono += v;
      }
      mono /= ch;
      sum += mono * mono;
    }
    const rms = Math.sqrt(sum / Math.max(frames, 1));
    let rawGain: number;
    if (rms < SILENCE_RMS) {
      rawGain = history.length ? history[history.length - 1]! : 1;
    } else {
      rawGain = Math.min(MAX_GAIN, targetRms / rms);
      if (peak > 0) rawGain = Math.min(rawGain, PEAK_CEIL / peak);
    }
    return { data, frames, rawGain, peak };
  };

  /** Smoothed gain for queue index qi (window over available neighbors). */
  const smoothed = (qi: number): number => {
    let num = 0;
    let den = 0;
    for (let k = -LOOKAHEAD; k <= LOOKAHEAD; k++) {
      const idx = qi + k;
      if (idx < 0 || idx >= queue.length) continue;
      const w = weights[k + LOOKAHEAD]!;
      num += w * queue[idx]!.rawGain;
      den += w;
    }
    return den > 0 ? num / den : 1;
  };

  const emitFrame = (qi: number): Float32Array => {
    const f = queue[qi]!;
    // this frame's hard ceiling — applied to the INTERPOLATED gain too, or
    // the ramp from a louder previous gain clips the frame's onset
    const limit = f.peak > 0 ? PEAK_CEIL / f.peak : Infinity;
    const g = Math.min(smoothed(qi), limit);
    const out = new Float32Array(f.frames * ch);
    const g0 = lastGain;
    for (let i = 0; i < f.frames; i++) {
      const t = f.frames > 1 ? i / (f.frames - 1) : 1;
      const gi = Math.min(g0 + (g - g0) * t, limit);
      for (let c = 0; c < ch; c++) out[i * ch + c] = f.data[i * ch + c]! * gi;
    }
    lastGain = g;
    emitted++;
    return out;
  };

  const concat = (parts: Float32Array[]): Float32Array => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Float32Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };

  return {
    process(input: Float32Array): Float32Array {
      // accumulate into whole frames
      const merged = concat([pending, input]);
      const wholeFrames = Math.floor(merged.length / (frameLen * ch));
      pending = merged.subarray(wholeFrames * frameLen * ch).slice();
      const outs: Float32Array[] = [];
      for (let f = 0; f < wholeFrames; f++) {
        const data = merged.subarray(f * frameLen * ch, (f + 1) * frameLen * ch).slice();
        const frame = analyze(data, frameLen);
        queue.push(frame);
        history.push(frame.rawGain);
        if (history.length > WINDOW * 2) history = history.slice(-WINDOW);
      }
      // emit every frame that has full lookahead; drop head frames once
      // they're beyond the smoothing window's reach
      while (emitted + LOOKAHEAD < queue.length) {
        outs.push(emitFrame(emitted));
        if (emitted > LOOKAHEAD) {
          queue.shift();
          emitted--;
        }
      }
      return outs.length ? concat(outs) : new Float32Array(0);
    },

    flush(): Float32Array {
      const outs: Float32Array[] = [];
      if (pending.length) {
        const frames = pending.length / ch;
        const frame = analyze(pending, frames);
        queue.push(frame);
        pending = new Float32Array(0);
      }
      while (emitted < queue.length) outs.push(emitFrame(emitted));
      queue.length = 0;
      emitted = 0;
      return outs.length ? concat(outs) : new Float32Array(0);
    },
  };
}

export function registerLevel(): void {
  if (getOp('level')) return;
  registerOp({
    kind: 'level',
    params: z.any(),
    media: { in: ['audio'], out: 'audio' },
    lower: {
      family: 'audio-kernel',
      create: async (raw, ctx) =>
        makeLevelTransform((raw as { target?: number }).target ?? -16, ctx),
    },
  });
}
