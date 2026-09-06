/**
 * Adaptive leveling kernel [H4]: a quiet-then-loud signal must come out with
 * far more consistent loudness, same length, no clipping — streamed through
 * process() in odd chunk sizes to exercise the frame accumulator.
 */
import { describe, expect, it } from 'vitest';
import { makeLevelTransform } from '../src/executor/levelKernel';

const RATE = 48000;

function sine(seconds: number, amp: number, freq = 440): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}

function windowedRms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
}

describe('makeLevelTransform', () => {
  it('evens out a quiet half and a loud half; length preserved; no clipping', () => {
    const quiet = sine(6, 0.05);
    const loud = sine(6, 0.5);
    const input = new Float32Array(quiet.length + loud.length);
    input.set(quiet);
    input.set(loud, quiet.length);

    const t = makeLevelTransform(-16, { rate: RATE, channels: 1 });
    const outs: Float32Array[] = [];
    // odd chunk size on purpose (never frame-aligned)
    for (let off = 0; off < input.length; off += 12_345) {
      outs.push(t.process(input.subarray(off, Math.min(off + 12_345, input.length))) as Float32Array);
    }
    outs.push(t.flush() as Float32Array);
    const total = outs.reduce((s, o) => s + o.length, 0);
    expect(total).toBe(input.length);

    const out = new Float32Array(total);
    let off = 0;
    for (const o of outs) { out.set(o, off); off += o.length; }

    // measure away from the transition (smoothing window spans ~3.5s)
    const mid = quiet.length;
    const inRatio = windowedRms(input, mid + RATE, mid + 3 * RATE) / windowedRms(input, RATE, 3 * RATE);
    const outRatio = windowedRms(out, mid + RATE, mid + 3 * RATE) / windowedRms(out, RATE, 3 * RATE);
    expect(inRatio).toBeGreaterThan(8); // sanity: input really is uneven
    expect(outRatio).toBeLessThan(2.5); // output is much flatter

    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]!));
    expect(peak).toBeLessThanOrEqual(1.0);
  });

  it('stereo: channel balance is preserved (shared gain)', () => {
    const l = sine(4, 0.1);
    const inter = new Float32Array(l.length * 2);
    for (let i = 0; i < l.length; i++) {
      inter[i * 2] = l[i]!;
      inter[i * 2 + 1] = l[i]! * 0.5; // right at half amplitude
    }
    const t = makeLevelTransform(-16, { rate: RATE, channels: 2 });
    const a = t.process(inter) as Float32Array;
    const b = t.flush() as Float32Array;
    const out = new Float32Array(a.length + b.length);
    out.set(a); out.set(b, a.length);
    // pick samples mid-file: R/L ratio still 0.5
    const i0 = Math.floor(out.length / 4) & ~1;
    let ratioSum = 0, n = 0;
    for (let i = i0; i < i0 + 2000; i += 2) {
      if (Math.abs(out[i]!) > 1e-3) { ratioSum += out[i + 1]! / out[i]!; n++; }
    }
    expect(ratioSum / n).toBeCloseTo(0.5, 2);
  });

  it('silence is not amplified (gain holds)', () => {
    const t = makeLevelTransform(-16, { rate: RATE, channels: 1 });
    const silence = new Float32Array(RATE * 4); // 4s of digital silence
    const a = t.process(silence) as Float32Array;
    const b = t.flush() as Float32Array;
    let peak = 0;
    for (const arr of [a, b]) for (let i = 0; i < arr.length; i++) peak = Math.max(peak, Math.abs(arr[i]!));
    expect(peak).toBe(0);
  });
});
