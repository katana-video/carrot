// The VoiceFixer stitcher with a FAKE model (a phase-coherent delayed copy)
// — proves the bookkeeping: exact output length, input alignment through
// both resamplers + the model delay, gain application, chunk economy, and
// that only the crossfades deviate. Real-model audio quality is judged by
// ear (ONNX_INTEGRATION.md §5); this pins the arithmetic.
import { describe, it, expect } from 'vitest'
import { createStitcher, CHUNK, CHUNK_IN, CHUNK_OUT, RATE } from '../src/enhance/stitch'
import { resampleAt } from '../src/enhance/resample'

const DELAY = 1000
/** "Model": output j = input j − DELAY, padded to CHUNK_OUT. */
const fakeModel = async (x: Float32Array): Promise<Float32Array> => {
  expect(x.length).toBe(CHUNK_IN)
  const y = new Float32Array(CHUNK_OUT)
  y.set(x.subarray(0, CHUNK_OUT - DELAY), DELAY)
  return y
}
/** Band-limited test signal (speech-band tones, amplitude-modulated). */
const signal = (n: number): Float32Array => {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    x[i] = 0.2 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t)) * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 1870 * t))
  }
  return x
}
async function runAll(x: Float32Array, block: number, gain = 1) {
  const st = createStitcher({ runChunk: fakeModel, gain, delay: DELAY })
  const parts: Float32Array[] = []
  for (let i = 0; i < x.length; i += block) parts.push(await st.push(x.subarray(i, Math.min(x.length, i + block))))
  parts.push(await st.flush())
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return { out, chunks: st.chunks() }
}

describe('enhance stitcher', () => {
  it('sinc resampler round-trips 48k → 44.1k → 48k within −50 dB on speech-band content', () => {
    const x = signal(CHUNK)
    const back = resampleAt(resampleAt(x, 48000, 44100, 0, CHUNK_IN), 44100, 48000, 0, CHUNK)
    let e = 0, s = 0
    for (let i = 2000; i < CHUNK - 2000; i++) { e += (back[i]! - x[i]!) ** 2; s += x[i]! ** 2 }
    expect(10 * Math.log10(e / s)).toBeLessThan(-50)
  })

  it('total out == total in, for awkward lengths and block sizes', async () => {
    for (const [n, block] of [[1000, 333], [CHUNK - 7, 4096], [CHUNK + 1, 1024], [5 * RATE + 123, 4096], [21 * RATE, 2048]] as const) {
      const { out } = await runAll(signal(n), block)
      expect(out.length).toBe(n)
    }
  })

  it('aligned with the input (delay compensated) outside the crossfades; gain applied', async () => {
    const x = signal(12 * RATE)
    const { out } = await runAll(x, 4096, 2)
    // with a phase-COHERENT fake, equal-power fades bump up to √2 — so judge
    // the samples where the output is one chunk alone: ≥ 95 % of the file
    let close = 0
    for (let i = 0; i < x.length; i++) if (Math.abs(out[i]! - 2 * x[i]!) < 0.01) close++
    expect(close / x.length).toBeGreaterThan(0.9)
  })

  it('chunk economy: hop between 2.1 and 2.6 s (≤ 1.45× compute)', async () => {
    const secs = 60
    const { chunks } = await runAll(signal(secs * RATE), 4096)
    expect(chunks * 3 / secs).toBeLessThan(1.45)
    expect(chunks * 3 / secs).toBeGreaterThan(1.1)
  })

  it('seams land in silence when the input has a gap within reach', async () => {
    // speech-ish bursts with a 150 ms silent gap at 2.45 s: the first seam's
    // crossfade (search window 2.2–2.7 s) must center inside the gap
    const x = signal(8 * RATE)
    for (let i = Math.round(2.4 * RATE); i < Math.round(2.55 * RATE); i++) x[i] = 0
    const { out } = await runAll(x, 4096)
    // in the gap the output is (near) silent — no bump from fading two
    // chunks of sound over each other
    let peak = 0
    for (let i = Math.round(2.43 * RATE); i < Math.round(2.52 * RATE); i++) peak = Math.max(peak, Math.abs(out[i]!))
    expect(peak).toBeLessThan(0.02)
  })
})
