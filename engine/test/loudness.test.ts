/**
 * BS.1770 meter validation on synthetic signals with known loudness:
 * the −0.691 spec constant exactly cancels the K-weighting response at
 * 997 Hz, so a stereo sine of amplitude A in both channels reads
 * ≈ 20·log10(A) LUFS (per-channel mean squares sum to A²).
 */
import { describe, expect, it } from 'vitest';
import { LoudnessMeter, kWeightCoeffs } from '../src/loudness';

function sine(rate: number, seconds: number, freq: number, amp: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe('kWeightCoeffs', () => {
  it('matches the spec’s canonical 48 kHz coefficients', () => {
    const { shelf, highpass } = kWeightCoeffs(48000);
    // ITU-R BS.1770-4 Table 1 / Table 2
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 4);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 4);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 4);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 4);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 4);
    expect(highpass.a1).toBeCloseTo(-1.99004745483398, 4);
    expect(highpass.a2).toBeCloseTo(0.99007225036621, 4);
  });
});

describe('LoudnessMeter', () => {
  it('997 Hz stereo sine at −20 dBFS reads ≈ −20 LUFS', () => {
    const rate = 48000;
    const ch = sine(rate, 5, 997, Math.pow(10, -20 / 20));
    const meter = new LoudnessMeter(rate, 2);
    meter.addPlanar([ch, ch]);
    const r = meter.result();
    expect(r.integratedLufs).not.toBeNull();
    expect(r.integratedLufs!).toBeCloseTo(-20.0, 1);
    expect(r.samplePeakDb).toBeCloseTo(-20, 0);
    expect(r.duration).toBeCloseTo(5, 2);
  });

  it('works at 44.1 kHz (rate-agnostic filters)', () => {
    const rate = 44100;
    const ch = sine(rate, 5, 997, Math.pow(10, -14 / 20));
    const meter = new LoudnessMeter(rate, 2);
    meter.addPlanar([ch, ch]);
    expect(meter.result().integratedLufs!).toBeCloseTo(-14.0, 1);
  });

  it('gating: long near-silence does not drag down a short loud passage', () => {
    const rate = 48000;
    const loud = sine(rate, 2, 997, Math.pow(10, -18 / 20));
    const quiet = sine(rate, 20, 997, Math.pow(10, -80 / 20));
    const meter = new LoudnessMeter(rate, 1);
    meter.addPlanar([loud]);
    meter.addPlanar([quiet]);
    const r = meter.result();
    // mono single channel: −18 dB amp → ≈ −18 − 3.01 − 0.69 ≈ −21.7 LUFS
    expect(r.integratedLufs!).toBeGreaterThan(-24);
    expect(r.integratedLufs!).toBeLessThan(-19);
  });

  it('pure silence gates out to null', () => {
    const meter = new LoudnessMeter(48000, 1);
    meter.addPlanar([new Float32Array(48000)]);
    expect(meter.result().integratedLufs).toBeNull();
  });
});
