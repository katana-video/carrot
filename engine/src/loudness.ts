/**
 * Integrated loudness measurement per ITU-R BS.1770-4 / EBU R128:
 * K-weighting (high-shelf + high-pass biquads) → 400 ms blocks at 75 %
 * overlap → two-stage gating (absolute −70 LUFS, relative −10 LU).
 *
 * The meter core is pure and rate-agnostic (RBJ-designed filters from the
 * spec's published f0/Q/gain constants — validated against the spec's
 * canonical 48 kHz coefficients in tests); measureLoudness() streams a
 * Blob's audio through it via mediabunny without buffering the file.
 */
import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from 'mediabunny';
import { extractPlanar } from './nodes/audio';

export interface LoudnessFacts {
  /** Integrated loudness in LUFS; null when everything gated out (silence). */
  integratedLufs: number | null;
  /** Highest sample magnitude in dBFS (not true-peak; a safety input). */
  samplePeakDb: number;
  /** Seconds analyzed. */
  duration: number;
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

/** K-weighting stage filters for an arbitrary sample rate (RBJ cookbook,
 *  constants from BS.1770's filter derivation). */
export function kWeightCoeffs(rate: number): { shelf: Biquad; highpass: Biquad } {
  // stage 1: high shelf f0=1681.974450955533, G=+3.999843853973347 dB, Q=0.7071752369554196
  {
    // (computed below and returned together)
  }
  const shelf = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / rate);
    const Vh = Math.pow(10, G / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const d = 1 + K / Q + K * K;
    return {
      b0: (Vh + (Vb * K) / Q + K * K) / d,
      b1: (2 * (K * K - Vh)) / d,
      b2: (Vh - (Vb * K) / Q + K * K) / d,
      a1: (2 * (K * K - 1)) / d,
      a2: (1 - K / Q + K * K) / d,
    };
  })();
  const highpass = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / rate);
    const d = 1 + K / Q + K * K;
    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (K * K - 1)) / d,
      a2: (1 - K / Q + K * K) / d,
    };
  })();
  return { shelf, highpass };
}

class BiquadState {
  private z1 = 0;
  private z2 = 0;
  constructor(private readonly c: Biquad) {}
  process(x: number): number {
    // transposed direct form II
    const y = this.c.b0 * x + this.z1;
    this.z1 = this.c.b1 * x - this.c.a1 * y + this.z2;
    this.z2 = this.c.b2 * x - this.c.a2 * y;
    return y;
  }
}

const SUB_S = 0.1; // 100 ms sub-blocks; a gating block = 4 consecutive

/** Streaming BS.1770 meter. Feed planar chunks (any length); read result(). */
export class LoudnessMeter {
  private readonly filters: BiquadState[][] = [];
  private readonly subSize: number;
  /** Per-channel running sum of squares within the current sub-block. */
  private readonly subSum: number[];
  private subCount = 0;
  /** Completed sub-block mean-squares, summed over channels. */
  private readonly subBlocks: number[] = [];
  private peak = 0;
  private samples = 0;

  constructor(private readonly rate: number, private readonly channels: number) {
    const { shelf, highpass } = kWeightCoeffs(rate);
    for (let c = 0; c < channels; c++) {
      this.filters.push([new BiquadState(shelf), new BiquadState(highpass)]);
    }
    this.subSize = Math.round(rate * SUB_S);
    this.subSum = new Array<number>(channels).fill(0);
  }

  /** chans.length must equal the constructor's channel count. */
  addPlanar(chans: Float32Array[]): void {
    const n = chans[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        const raw = chans[c]![i]!;
        const a = Math.abs(raw);
        if (a > this.peak) this.peak = a;
        const [f1, f2] = this.filters[c]!;
        const w = f2!.process(f1!.process(raw));
        this.subSum[c] = this.subSum[c]! + w * w;
      }
      this.samples++;
      if (++this.subCount === this.subSize) {
        let sum = 0;
        for (let c = 0; c < this.channels; c++) {
          sum += this.subSum[c]! / this.subSize; // per-channel mean square, weight 1
          this.subSum[c] = 0;
        }
        this.subBlocks.push(sum);
        this.subCount = 0;
      }
    }
  }

  result(): LoudnessFacts {
    // 400 ms gating blocks at 75 % overlap = every 100 ms sub-block window of 4
    const energies: number[] = [];
    for (let i = 0; i + 4 <= this.subBlocks.length; i++) {
      energies.push((this.subBlocks[i]! + this.subBlocks[i + 1]! + this.subBlocks[i + 2]! + this.subBlocks[i + 3]!) / 4);
    }
    const lufs = (e: number) => -0.691 + 10 * Math.log10(Math.max(e, 1e-12));
    const abs = energies.filter((e) => lufs(e) > -70);
    let integrated: number | null = null;
    if (abs.length) {
      const absMean = abs.reduce((s, e) => s + e, 0) / abs.length;
      const relThreshold = lufs(absMean) - 10;
      const rel = abs.filter((e) => lufs(e) > relThreshold);
      if (rel.length) {
        integrated = lufs(rel.reduce((s, e) => s + e, 0) / rel.length);
      }
    }
    return {
      integratedLufs: integrated,
      samplePeakDb: this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity,
      duration: this.samples / this.rate,
    };
  }
}

/** Stream a blob's audio through the meter (worker-side; O(blocks) memory). */
export async function measureLoudness(
  source: Blob,
  opts: { maxSeconds?: number } = {},
): Promise<LoudnessFacts> {
  const maxSeconds = opts.maxSeconds ?? 4 * 3600;
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('no audio track to analyze');
  const duration = Math.min(await input.computeDuration(), maxSeconds);

  let meter: LoudnessMeter | null = null;
  const sink = new AudioSampleSink(track);
  for await (const s of sink.samples(0, duration)) {
    const channels = Math.min(2, s.numberOfChannels); // >2ch: front pair, weight 1
    meter ??= new LoudnessMeter(s.sampleRate, channels);
    const chans = extractPlanar(s, channels);
    s.close();
    meter.addPlanar(chans);
  }
  if (!meter) throw new Error('no audio samples decoded');
  return meter.result();
}
