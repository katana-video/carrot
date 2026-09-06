// Tier-1 [H] denoise runtime tests — the production longpipe kernels driven
// offline in Node against the playground's own eval fixtures (clean speech +
// 0 dB SNR noisy mix from the DFN repo assets, and Sam's June reference
// outputs from the fused tract-parity build).
//
// Oracles (chosen the hard way — see the first-run finding below):
//  - Similarity to the reference outputs from the original evaluation: the
//    decisive correctness oracle. Our offline loop reproduces the June fused
//    build at ~76 dB SNR — numerically the same net.
//  - Noise attenuation during speech pauses (lowest-energy clean frames):
//    the perceptually honest "did it denoise" measure.
//  - NOT global waveform SNR-vs-clean: denoisers spectrally reshape the
//    speech itself, so even the reference build only "improves" the 0 dB mix
//    to ~7.6 dB gain-optimal global SNR. That metric under-reports real
//    suppression and would reject correct kernels.
// Measured pipeline delay: 1440 samples (3 hops, 30 ms) — the engine's [H3]
// executor must trim this lead-in when splicing denoised audio back.
//
// Prereq: node test/fetch-denoise-vendor.mjs (test/vendor/ is gitignored).
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOfflineDenoiser, KERNELS, type DenoiseModel } from '../src/denoise/kernel'
import { readWav } from './helpers/wav'

const dir = dirname(fileURLToPath(import.meta.url))
const vendor = (f: string) => join(dir, 'vendor', f)
const fixture = (f: string) => join(dir, 'fixtures', 'denoise', f)

const haveVendor = ['dfn.wasm', 'dfn_weights.pack', 'dfn_weights_int8.pack', 'rnnoise.wasm']
  .every((f) => existsSync(vendor(f)))

// Signal-to-noise ratio of `x` against reference `ref`, maximizing over an
// alignment lag (x delayed by `lag` relative to ref). Coarse search on
// decimated signals, then exact refinement.
function alignedSnr(ref: Float32Array, x: Float32Array, maxLag = 2400): { snr: number; lag: number } {
  const stride = 8
  let bestLag = 0
  let bestCorr = -Infinity
  for (let lag = 0; lag <= maxLag; lag += stride) {
    let c = 0
    for (let i = 0; i + lag < x.length && i < ref.length; i += stride) c += ref[i] * x[i + lag]
    if (c > bestCorr) { bestCorr = c; bestLag = lag }
  }
  for (let lag = Math.max(0, bestLag - stride); lag <= bestLag + stride; lag++) {
    let c = 0
    for (let i = 0; i + lag < x.length && i < ref.length; i += 4) c += ref[i] * x[i + lag]
    if (c > bestCorr) { bestCorr = c; bestLag = lag }
  }
  // Optimal gain (the kernels aren't unity-gain on the speech component).
  let dot = 0, xx = 0
  const n = Math.min(ref.length, x.length - bestLag)
  for (let i = 0; i < n; i++) { dot += ref[i] * x[i + bestLag]; xx += x[i + bestLag] ** 2 }
  const g = xx > 0 ? dot / xx : 1
  let sig = 0, err = 0
  for (let i = 0; i < n; i++) {
    const e = ref[i] - g * x[i + bestLag]
    sig += ref[i] ** 2
    err += e * e
  }
  return { snr: 10 * Math.log10(sig / err), lag: bestLag }
}

// Plain SNR at lag 0, unity gain — for validating the additive fixture mix.
function plainSnr(ref: Float32Array, x: Float32Array): number {
  let sig = 0, err = 0
  const n = Math.min(ref.length, x.length)
  for (let i = 0; i < n; i++) { sig += ref[i] ** 2; err += (ref[i] - x[i]) ** 2 }
  return 10 * Math.log10(sig / err)
}

// Noise attenuation in speech pauses: energy in the quietest-decile clean
// frames, noisy vs processed (aligned by `lag`). What suppression sounds like.
function pauseAttenuationDb(clean: Float32Array, noisy: Float32Array, out: Float32Array, lag: number): number {
  const F = 480
  const frames: { i: number; e: number }[] = []
  for (let i = 0; (i + 1) * F <= clean.length; i++) {
    let e = 0
    for (let j = i * F; j < (i + 1) * F; j++) e += clean[j] ** 2
    frames.push({ i, e })
  }
  frames.sort((a, b) => a.e - b.e)
  const quiet = frames.slice(0, Math.max(1, Math.floor(frames.length / 10)))
  let before = 0, after = 0
  for (const { i } of quiet) {
    for (let j = i * F; j < (i + 1) * F; j++) {
      before += noisy[j] ** 2
      const k = j + lag
      if (k < out.length) after += out[k] ** 2
    }
  }
  return 10 * Math.log10(before / after)
}

function bytes(model: DenoiseModel) {
  const cfg = KERNELS[model]
  return {
    wasm: readFileSync(vendor(cfg.wasm)),
    weights: cfg.weights ? readFileSync(vendor(cfg.weights)) : null,
  }
}

describe.skipIf(!haveVendor)('offline denoise kernels (longpipe production binaries)', () => {
  let clean: Float32Array
  let noisy: Float32Array
  let baseline: number

  beforeAll(() => {
    clean = readWav(fixture('clean.wav')).samples
    noisy = readWav(fixture('noisy_snr0.wav')).samples
    baseline = plainSnr(clean, noisy)
  })

  it('fixture is the stated 0 dB mix (−3 dB global: LSNR is speech-active)', () => {
    // The playground's "SNR0" is DFN-convention loudness/active-speech SNR;
    // globally the additive mix measures ≈ −3 dB because pauses contribute
    // noise but no speech. Pinned as a fixture-integrity check.
    expect(baseline).toBeGreaterThan(-4)
    expect(baseline).toBeLessThan(-2)
  })

  it('ABI smoke: every kernel instantiates, creates state, survives a silent hop', () => {
    for (const model of ['rnnoise', 'dfn', 'dfnint8'] as const) {
      const d = createOfflineDenoiser(model, bytes(model))
      const out = d.run(new Float32Array(480))
      expect(out.length).toBe(480)
      expect(out.every(Number.isFinite)).toBe(true)
    }
  })

  it('DFN3 f32 reproduces the evaluated build and audibly suppresses pause noise', () => {
    const d = createOfflineDenoiser('dfn', bytes('dfn'))
    const out = d.run(noisy)
    const { lag } = alignedSnr(clean, out)
    const ref = readWav(fixture('dfn3_ref_snr0.wav')).samples
    const drift = alignedSnr(ref, out).snr
    const atten = pauseAttenuationDb(clean, noisy, out, lag)
    console.log(`dfn f32: ours-vs-ref similarity ${drift.toFixed(1)} dB; pipeline lag ${lag}; ` +
      `pause attenuation ${atten.toFixed(1)} dB; ${d.msPerHop().toFixed(3)} ms/hop`)
    expect(drift).toBeGreaterThan(40)             // same net as the evaluated build (measured ~76)
    expect(atten).toBeGreaterThan(10)             // decisive suppression where only noise lives
    expect(lag).toBe(1440)                        // fixed 3-hop delay — [H3] trims this
  })

  it('DFN3 int8 stays close to f32 and still suppresses', () => {
    const f32 = createOfflineDenoiser('dfn', bytes('dfn')).run(noisy)
    const d = createOfflineDenoiser('dfnint8', bytes('dfnint8'))
    const i8 = d.run(noisy)
    const sim = alignedSnr(f32, i8, 8).snr
    const atten = pauseAttenuationDb(clean, noisy, i8, alignedSnr(clean, i8).lag)
    console.log(`dfn int8: ${sim.toFixed(1)} dB similarity to f32; pause attenuation ${atten.toFixed(1)} dB`)
    expect(sim).toBeGreaterThan(20)               // HANDOFF claims ~36 dB on their clip
    expect(atten).toBeGreaterThan(10)
  })

  it('RNNoise floor matches its own reference evaluation', () => {
    const d = createOfflineDenoiser('rnnoise', bytes('rnnoise'))
    const out = d.run(noisy)
    const { snr, lag } = alignedSnr(clean, out)
    const refSnr = alignedSnr(clean, readWav(fixture('rnnoise_ref_snr0.wav')).samples).snr
    const atten = pauseAttenuationDb(clean, noisy, out, lag)
    console.log(`rnnoise: ${snr.toFixed(1)} dB vs clean (reference build ${refSnr.toFixed(1)}); ` +
      `pause attenuation ${atten.toFixed(1)} dB; ${d.msPerHop().toFixed(3)} ms/hop`)
    expect(snr).toBeGreaterThan(refSnr - 1.5)     // no worse than the evaluated build
    expect(atten).toBeGreaterThan(3)              // the floor tier suppresses less, but audibly
  })

  it('runs comfortably faster than realtime', () => {
    const d = createOfflineDenoiser('dfn', bytes('dfn'))
    d.run(noisy.subarray(0, 480 * 100))           // 1 s of audio
    expect(d.msPerHop()).toBeLessThan(10)         // 10 ms of audio per hop = RTF 1
  })
})
