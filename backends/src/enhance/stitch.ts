/**
 * Chunk stitching for VoiceFixer (ONNX_INTEGRATION.md §5): the model only
 * takes fixed 3 s windows, and its vocoder invents its own phase, so two
 * chunks covering the same audio are perceptually alike but phase-UNRELATED
 * — sample-accurate overlap-add comb-filters. The recipe:
 *
 *   - consecutive chunks overlap; a short EQUAL-POWER (sin/cos) crossfade sits
 *     in the middle of the overlap (uncorrelated signals: a linear fade dips
 *     ~3 dB at its center, sin/cos holds power);
 *   - each chunk's first and last MARGIN never reach the output — the model's
 *     lead-in/warm-up and its end-of-window behaviour stay inside the overlap;
 *   - the seam goes where the INPUT is quietest within a search window, so
 *     whatever residue a seam leaves lands between words.
 *
 * Streaming and pure: 48 kHz mono in, the same number of samples out (after
 * flush), the model injected as `runChunk` — Node tests drive it with a fake
 * model; the kernel and the preview drive it with the ONNX session.
 */
import { resampleAt } from './resample';

export const RATE = 48000;
export const MODEL_RATE = 44100;
/** Model input: exactly 3 s @ 44.1 kHz. */
export const CHUNK_IN = 132300;
/** Model output length for one chunk (+6 hops). */
export const CHUNK_OUT = 134946;
/** One chunk in the 48 kHz domain (3 s). */
export const CHUNK = 144000;

export interface StitchOptions {
  /** One model call: CHUNK_IN samples @ 44.1 kHz → CHUNK_OUT samples. */
  runChunk: (x: Float32Array) => Promise<Float32Array>;
  /** Linear gain applied to every input sample (the whole-file peak
   *  normalisation: 0.8 / peak). The model is level-SENSITIVE (§4). */
  gain: number;
  /** Output sample j ↔ input sample (j − delay), both @ 44.1 kHz. */
  delay: number;
  /** Seconds; defaults are the validated configuration. */
  fade?: number;
  margin?: number;
  search?: number;
}

export interface Stitcher {
  /** Feed 48 kHz mono; returns whatever output is now final. */
  push(input: Float32Array): Promise<Float32Array>;
  /** End of stream: returns the remainder (total out == total in). */
  flush(): Promise<Float32Array>;
  /** Model calls made so far (cost accounting / tests). */
  chunks(): number;
}

/** Soft knee: transparent below 0.85, asymptotic to 0.94 (≈ −0.5 dBFS).
 *  The model lands near full scale and the fades can stack (§4), and the
 *  output is re-encoded (aac/opus overshoot sample peaks by a fraction of
 *  a dB) — a 1.0 ceiling measured 0 dBFS after encode in the smoke. */
function limit(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.85) return x;
  return Math.sign(x) * (0.85 + 0.09 * Math.tanh((a - 0.85) / 0.09));
}

export function createStitcher(opts: StitchOptions): Stitcher {
  const F = Math.round((opts.fade ?? 0.2) * RATE);
  const M = Math.round((opts.margin ?? 0.1) * RATE);
  const T = Math.round((opts.search ?? 0.5) * RATE);
  const FRAME = Math.round(0.02 * RATE); // energy frame for seam search

  // input buffer: absolute sample index `base` is buf[0]
  let buf = new Float32Array(0);
  let base = 0;
  let fed = 0;
  let emitted = 0;
  let calls = 0;
  /** The last enhanced chunk, input-aligned @ 48 kHz. */
  let prev: { start: number; y: Float32Array } | null = null;

  const inputAt = (i: number): number => {
    const k = i - base;
    return k >= 0 && k < buf.length ? buf[k]! : 0;
  };
  const energy = (center: number): number => {
    let e = 0;
    for (let i = center - FRAME / 2; i < center + FRAME / 2; i++) { const v = inputAt(i); e += v * v; }
    return e;
  };

  async function enhance(start: number): Promise<Float32Array> {
    const x48 = new Float32Array(CHUNK);
    for (let i = 0; i < CHUNK; i++) x48[i] = inputAt(start + i) * opts.gain;
    const x44 = resampleAt(x48, RATE, MODEL_RATE, 0, CHUNK_IN);
    calls++;
    const y44 = await opts.runChunk(x44);
    return resampleAt(y44, MODEL_RATE, RATE, opts.delay, CHUNK);
  }

  /** Emit absolute [from, to) out of `prev`. */
  const fromPrev = (from: number, to: number, out: number[]): void => {
    for (let i = from; i < to; i++) out.push(limit(prev!.y[i - prev!.start] ?? 0));
  };

  /** Run every chunk the buffered input allows; `final` = no more input. */
  async function drain(final: boolean): Promise<Float32Array> {
    const out: number[] = [];
    for (;;) {
      if (!prev) {
        if (!final && fed < CHUNK) break;
        if (fed === 0) break;
        prev = { start: 0, y: await enhance(0) };
        continue;
      }
      const prevEnd = prev.start + CHUNK;
      if (final && fed <= prevEnd - M) break; // prev covers the rest
      // latest crossfade center that keeps the fade off prev's tail margin
      const cMax = prevEnd - M - Math.ceil(F / 2);
      let c = cMax;
      let best = Infinity;
      for (let cand = cMax; cand >= cMax - T; cand -= FRAME / 2) {
        const e = energy(cand);
        if (e < best) { best = e; c = cand; }
      }
      const start = c - Math.floor(F / 2) - M;
      if (!final && fed < start + CHUNK) break; // the next chunk's input isn't here yet
      const cur = await enhance(start);
      const f0 = c - Math.floor(F / 2);
      fromPrev(emitted, f0, out);
      for (let k = 0; k < F; k++) {
        const th = (Math.PI / 2) * ((k + 0.5) / F);
        const i = f0 + k;
        out.push(limit(prev.y[i - prev.start]! * Math.cos(th) + cur[i - start]! * Math.sin(th)));
      }
      emitted = f0 + F;
      prev = { start, y: cur };
      // input before the new chunk is never read again
      const drop = Math.min(start - base, buf.length);
      if (drop > 0) { buf = buf.slice(drop); base += drop; }
    }
    if (final && prev) {
      fromPrev(emitted, fed, out);
      emitted = fed;
    }
    return Float32Array.from(out);
  }

  return {
    async push(input) {
      const next = new Float32Array(buf.length + input.length);
      next.set(buf);
      next.set(input, buf.length);
      buf = next;
      fed += input.length;
      return drain(false);
    },
    flush: () => drain(true),
    chunks: () => calls,
  };
}
