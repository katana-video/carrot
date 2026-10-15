/**
 * Windowed-sinc resampling at arbitrary source positions — the 48 kHz ⇄
 * 44.1 kHz bridge around VoiceFixer. Offline and per-chunk (the stitcher
 * hands whole buffers), so no streaming filter state: output sample i is
 * evaluated at source position `start + i * fromRate / toRate` directly.
 *
 * Linear interpolation (the engine's conform path) is fine for speed
 * changes, but this model regenerates content up to 22 kHz — a sinc
 * kernel keeps that band clean instead of imaging/aliasing it.
 */

const HALF = 16; // kernel half-width, in source samples

/** Blackman-windowed sinc with cutoff `fc` (fraction of the source Nyquist). */
function kernel(x: number, fc: number): number {
  if (Math.abs(x) >= HALF) return 0;
  const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / HALF) + 0.08 * Math.cos((2 * Math.PI * x) / HALF);
  const t = Math.PI * fc * x;
  return fc * (t === 0 ? 1 : Math.sin(t) / t) * w;
}

/**
 * Resample `src` (rate `fromRate`) to `count` samples at `toRate`, the first
 * output sample sitting at source position `start` (in source samples, may
 * be fractional or negative). Samples outside `src` read as silence.
 */
export function resampleAt(src: Float32Array, fromRate: number, toRate: number, start: number, count: number): Float32Array {
  const step = fromRate / toRate;
  // downsampling cuts below the TARGET Nyquist; 0.97 leaves transition headroom
  const fc = Math.min(1, toRate / fromRate) * 0.97;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = start + i * step;
    const lo = Math.max(0, Math.floor(p) - HALF + 1);
    const hi = Math.min(src.length - 1, Math.floor(p) + HALF);
    let acc = 0;
    for (let n = lo; n <= hi; n++) acc += src[n]! * kernel(p - n, fc);
    out[i] = acc;
  }
  return out;
}
