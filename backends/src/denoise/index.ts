/**
 * Denoise audio-kernel — `@katana-video/carrot-backends/denoise`.
 *
 * Registers the engine's `denoise` op [H2/H3]: DeepFilterNet (DFN3, f32 or
 * int8) or RNNoise as offline wasm kernels over 48 kHz mono hops, channels
 * downmixed and re-duplicated, the kernels' fixed lead-in trimmed so output
 * stays sample-aligned with input. Weights come from the configured mirror
 * or cdn.katana.video (see ../weights.ts and that directory's
 * WEIGHTS_LICENSE: DeepFilterNet MIT/Apache-2.0, RNNoise BSD-3).
 *
 * No dependencies beyond the engine and zod; the wasm is fetched on the
 * first run and cached in the browser Cache API.
 */
import { z } from 'zod';
import { registerOp, getOp, type AudioStreamTransform } from '@katana-video/carrot';
import { createOfflineDenoiser, HOP, KERNELS, type DenoiseModel } from './kernel';
import { denoiseWeightsBase, fetchCached } from '../weights';

export { HOP, KERNELS, createOfflineDenoiser, type DenoiseModel, type OfflineDenoiser } from './kernel';

/** Fixed 3-hop lead-in of the DFN kernels (measured, pinned in tests). */
const DENOISE_DELAY = 1440;

/** The IR's tiers (`{type:'denoise', model}`) → kernels. */
const DENOISE_MODEL: Record<string, DenoiseModel> = {
  auto: 'dfn', high: 'dfn', mid: 'dfnint8', low: 'rnnoise',
};

export interface DenoiseOptions {
  /** Directory holding rnnoise.wasm / dfn.wasm / dfn_weights*.pack; overrides configureWeights. */
  weightsBaseUrl?: string;
  /** Download progress for the UI (bytes) — the engine's kernel context has no channel for it. */
  onModelProgress?: (loaded: number, total: number) => void;
}

/** Idempotent: registering twice is a no-op, so hosts and tests can call freely. */
export function registerDenoise(opts: DenoiseOptions = {}): void {
  if (getOp('denoise')) return;
  registerOp({
    kind: 'denoise',
    params: z.any(),
    media: { in: ['audio'], out: 'audio' },
    lower: {
      family: 'audio-kernel',
      create: async (raw, ctx): Promise<AudioStreamTransform> => {
        if (ctx.rate !== 48000) {
          throw new Error(`denoise runs at 48 kHz; plan requested ${ctx.rate}`);
        }
        const model = DENOISE_MODEL[(raw as { model?: string }).model ?? 'auto'] ?? 'dfn';
        const spec = KERNELS[model];
        const base = denoiseWeightsBase(opts.weightsBaseUrl);
        const den = createOfflineDenoiser(model, {
          wasm: await fetchCached(`${base}${spec.wasm}`, opts.onModelProgress),
          weights: spec.weights ? await fetchCached(`${base}${spec.weights}`, opts.onModelProgress) : null,
        });
        const delay = model === 'rnnoise' ? 0 : DENOISE_DELAY;
        const ch = ctx.channels;
        let acc: Float32Array = new Float32Array(0);
        let toDrop = delay;
        let fedFrames = 0;
        let emittedFrames = 0;

        const upmix = (mono: Float32Array): Float32Array => {
          const out = new Float32Array(mono.length * ch);
          for (let i = 0; i < mono.length; i++) {
            for (let c = 0; c < ch; c++) out[i * ch + c] = mono[i]!;
          }
          return out;
        };
        const runWhole = (mono: Float32Array): Float32Array => {
          const out = den.run(mono);
          if (toDrop === 0) return out;
          const drop = Math.min(toDrop, out.length);
          toDrop -= drop;
          return out.subarray(drop) as Float32Array;
        };

        return {
          process(input: Float32Array): Float32Array {
            const frames = input.length / ch;
            fedFrames += frames;
            const mono = new Float32Array(acc.length + frames);
            mono.set(acc);
            for (let i = 0; i < frames; i++) {
              let s = 0;
              for (let c = 0; c < ch; c++) s += input[i * ch + c]!;
              mono[acc.length + i] = s / ch;
            }
            const whole = Math.floor(mono.length / HOP) * HOP;
            acc = mono.subarray(whole) as Float32Array;
            if (!whole) return new Float32Array(0);
            const out = runWhole(mono.subarray(0, whole) as Float32Array);
            emittedFrames += out.length;
            return upmix(out);
          },
          flush(): Float32Array {
            const owed = fedFrames - emittedFrames;
            if (owed <= 0) return new Float32Array(0);
            const padded = new Float32Array(Math.ceil((acc.length + delay) / HOP) * HOP);
            padded.set(acc);
            const out = runWhole(padded);
            emittedFrames += Math.min(owed, out.length);
            return upmix(out.subarray(0, Math.min(owed, out.length)) as Float32Array);
          },
        };
      },
    },
  });
}
