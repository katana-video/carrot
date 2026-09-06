/**
 * Audio nodes and helpers — canonical-format conform, planar utilities.
 *
 * Conventions (webcodecs-fundamentals /audio/audio-data, E3):
 * - Working format is f32-planar: one Float32Array of length frames*channels,
 *   channel c occupying [c*frames, (c+1)*frames).
 * - Mediabunny AudioSample timestamps are SECONDS (raw AudioData would be
 *   microseconds — that boundary never crosses into this package's API).
 * - Mixing/placement is by TIMESTAMP, never by array index.
 * - Mono → stereo by channel duplication; >2 channels take the first N.
 */

import { AudioSample } from 'mediabunny';
import type { Sec } from '../schema';

/** Extract a sample's channels as Float32Arrays, conforming channel count.
 * Mediabunny's copyTo converts any source layout to f32-planar for us. */
export function extractPlanar(s: AudioSample, channels: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const src = Math.min(c, s.numberOfChannels - 1);
    const buf = new Float32Array(s.numberOfFrames);
    s.copyTo(buf, { planeIndex: src, format: 'f32-planar' });
    out.push(buf);
  }
  return out;
}

/** Linear-interpolation resample of one channel (ratio = target/source rate). */
export function resampleLinear(src: Float32Array, ratio: number): Float32Array {
  if (ratio === 1) return src;
  const n = Math.floor(src.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    out[i] = src[i0]! + (pos - i0) * (src[i1]! - src[i0]!);
  }
  return out;
}

/** Stack channels into one f32-planar AudioSample. */
export function planarSample(channels: Float32Array[], rate: number, timestamp: Sec): AudioSample {
  const frames = channels[0]!.length;
  const data = new Float32Array(frames * channels.length);
  channels.forEach((ch, c) => data.set(ch, c * frames));
  return new AudioSample({
    data,
    format: 'f32-planar',
    numberOfChannels: channels.length,
    sampleRate: rate,
    timestamp,
  });
}

export interface ConformOptions {
  rate: number;
  channels: number;
  /** Source-time window [start, end); samples are clipped SAMPLE-ACCURATELY
   * to it (the audio span-boundary policy — video gates, audio trims). */
  windowStart: Sec;
  windowEnd: Sec;
  /** Source time → output time: t_out = t_src / speed + offset. */
  offset: Sec;
  /** Playback rate (source seconds per output second). ≠ 1 is the naive
   * speed path: samples are resampled by 1/speed, so pitch shifts (v0.1). */
  speed?: number;
}

/**
 * Transform node: conform audio to the plan's canonical format and clip to
 * the binding's window. Fast path: already-conforming samples fully inside
 * the window pass through untouched (a rebase at most).
 *
 * Also enforces the non-negative-timestamp contract at t=0 (AAC priming /
 * edit-list preroll — E1 discovery): output timestamps are never < 0.
 */
export function conformAudio(o: ConformOptions): TransformStream<AudioSample, AudioSample> {
  const speed = o.speed ?? 1;
  return new TransformStream<AudioSample, AudioSample>({
    transform(s, controller) {
      const end = s.timestamp + s.duration;
      if (end <= o.windowStart || s.timestamp >= o.windowEnd) { s.close(); return; }

      const conforming = s.sampleRate === o.rate && s.numberOfChannels === o.channels;
      const inside = s.timestamp >= o.windowStart && end <= o.windowEnd;
      if (conforming && inside && speed === 1) {
        if (o.offset !== 0) s.setTimestamp(s.timestamp + o.offset);
        controller.enqueue(s);
        return;
      }

      // Rebuild: extract, clip to the window in source frames, resample
      // (speed folds into the ratio — naive, pitch shifts), restack.
      const clipStartF = Math.round(Math.max(0, o.windowStart - s.timestamp) * s.sampleRate);
      const clipEndF = Math.min(s.numberOfFrames, Math.round((o.windowEnd - s.timestamp) * s.sampleRate));
      const ratio = o.rate / (s.sampleRate * speed);
      const chans = extractPlanar(s, o.channels).map((ch) =>
        resampleLinear(ch.subarray(clipStartF, clipEndF), ratio));
      const ts = Math.max(s.timestamp, o.windowStart) / speed + o.offset;
      s.close();
      if (chans[0]!.length > 0) controller.enqueue(planarSample(chans, o.rate, ts));
    },
  });
}

/** Apply a gain (possibly ramping over the sample's duration) in place-ish:
 * returns a new sample; closes the input. Used by the executor's mix lane. */
export function applyGain(s: AudioSample, gainAt: (t: Sec) => number): AudioSample {
  const chans = extractPlanar(s, s.numberOfChannels);
  const rate = s.sampleRate;
  const t0 = s.timestamp;
  for (const ch of chans) {
    for (let i = 0; i < ch.length; i++) ch[i]! *= gainAt(t0 + i / rate);
  }
  const out = planarSample(chans, rate, t0);
  s.close();
  return out;
}
