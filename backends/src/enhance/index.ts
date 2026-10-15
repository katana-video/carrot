/**
 * Voice enhancement — `@katana-video/carrot-backends/enhance`.
 *
 * Registers the engine's `enhance` op: undistilled VoiceFixer (denoise +
 * dereverb + bandwidth extension, a generative vocoder) as an ONNX graph on
 * onnxruntime-web's WebGPU EP. A whole-output audio kernel like denoise, with
 * two differences the engine accommodates:
 *
 *   - it is level-SENSITIVE: input is peak-normalised to 0.8 over the WHOLE
 *     lane, so the op declares `prepass: 'peak'` and the executor measures it
 *     before the real run;
 *   - it only takes fixed 3 s windows whose outputs are phase-unrelated, so
 *     long audio goes through the seam-aware stitcher (./stitch.ts).
 *
 * The model is 44.1 kHz mono; the kernel bridges the plan's 48 kHz with a
 * windowed-sinc resampler, downmixes, and re-duplicates channels (the output
 * is mono speech — stated in the IR description).
 *
 * Weights: cdn.katana.video/carrot/enhance/v/0.1.0/ (or the configured
 * mirror), ~224 MB once, Cache API afterwards. VoiceFixer code is MIT and
 * its checkpoint CC-BY-4.0 (Haohe Liu) — see WEIGHTS_LICENSE.
 */
import { z } from 'zod';
import { registerOp, getOp, type AudioStreamTransform } from '@katana-video/carrot';
import { enhanceWeightsBase, fetchCached } from '../weights';
import { createVoiceFixerSession, GRAPH_FILE, WEIGHTS_FILE, type VoiceFixerSession } from './model';
import { createStitcher, RATE } from './stitch';

export { enhanceSupported, createVoiceFixerSession, DEFAULT_ORT_URL, ORT_VERSION, type VoiceFixerSession } from './model';
export { createStitcher, CHUNK, CHUNK_IN, CHUNK_OUT, MODEL_RATE, RATE, type StitchOptions, type Stitcher } from './stitch';

/**
 * Output sample j ↔ input sample j − ENHANCE_DELAY (44.1 kHz). Measured on
 * the shipping graph (onnxruntime 1.23.2) by 5 ms-envelope cross-correlation
 * over six 3 s speech windows from three recordings: 940–1034 samples, all
 * r ≥ 0.83 — ~22.7 ms, matching ONNX_INTEGRATION.md's "2–3 hops". NOT the
 * 60 ms (2646-sample) output-length excess: that is lead-in padding, not lag.
 */
export const ENHANCE_DELAY = 1000;

/** Peak target the model was trained/referenced at (§4). */
const PEAK_TARGET = 0.8;

export interface EnhanceOptions {
  /** Directory holding the graph + weights; overrides configureWeights. */
  weightsBaseUrl?: string;
  /** Self-hosted copy of ort.webgpu.bundle.min.mjs (same pinned version). */
  ortUrl?: string;
  /** Download progress (bytes, both files combined) for the UI. */
  onModelProgress?: (loaded: number, total: number) => void;
}

/** Fetch both files (weights dominate) with combined byte progress. */
async function loadBytes(opts: EnhanceOptions): Promise<{ graph: ArrayBuffer; weights: ArrayBuffer }> {
  const base = enhanceWeightsBase(opts.weightsBaseUrl);
  const parts = { graph: [0, 0], weights: [0, 0] };
  const report = () => opts.onModelProgress?.(parts.graph[0]! + parts.weights[0]!, parts.graph[1]! + parts.weights[1]!);
  const [graph, weights] = await Promise.all([
    fetchCached(`${base}${GRAPH_FILE}`, (l, t) => { parts.graph = [l, t]; report(); }),
    fetchCached(`${base}${WEIGHTS_FILE}`, (l, t) => { parts.weights = [l, t]; report(); }),
  ]);
  return { graph, weights };
}

/** One session per worker/page: creation + warm-up costs seconds and ~1 GB of
 *  GPU memory, so repeat runs reuse it. */
let shared: Promise<VoiceFixerSession> | null = null;
function sharedSession(opts: EnhanceOptions): Promise<VoiceFixerSession> {
  if (!shared) {
    shared = loadBytes(opts).then((b) => createVoiceFixerSession(b, opts));
    shared.catch(() => { shared = null; }); // a failed load may be retried
  }
  return shared;
}

/** Download (with progress) + create + warm the shared session ahead of a
 *  run — lets a UI separate the one-time cost from inference timing. */
export async function prepareEnhance(opts: EnhanceOptions = {}): Promise<void> {
  await sharedSession(opts);
}

/** Release the shared session (e.g. before another context creates its own). */
export async function releaseEnhanceSession(): Promise<void> {
  const s = shared;
  shared = null;
  if (s) await (await s).release();
}

const gainFor = (peak: number): number => PEAK_TARGET / (peak + 1e-9);

/**
 * Offline whole-buffer enhancement — the preview path. `peak` should be the
 * WHOLE file's peak (not the window's), so the preview hears what the full
 * run will produce. 48 kHz mono in, same length out.
 */
export async function enhanceBuffer(mono48: Float32Array, peak: number, opts: EnhanceOptions = {}): Promise<Float32Array> {
  const session = await sharedSession(opts);
  const st = createStitcher({ runChunk: (x) => session.run(x), gain: gainFor(peak), delay: ENHANCE_DELAY });
  const head = await st.push(mono48);
  const tail = await st.flush();
  const out = new Float32Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
}

/** Idempotent: registering twice is a no-op. */
export function registerEnhance(opts: EnhanceOptions = {}): void {
  if (getOp('enhance')) return;
  registerOp({
    kind: 'enhance',
    params: z.any(),
    media: { in: ['audio'], out: 'audio' },
    lower: {
      family: 'audio-kernel',
      prepass: 'peak',
      create: async (_raw, ctx): Promise<AudioStreamTransform> => {
        if (ctx.rate !== RATE) throw new Error(`enhance runs at ${RATE} Hz; plan requested ${ctx.rate}`);
        if (ctx.peak === undefined) throw new Error('enhance needs the lane peak (engine prepass missing)');
        const session = await sharedSession(opts);
        const st = createStitcher({ runChunk: (x) => session.run(x), gain: gainFor(ctx.peak), delay: ENHANCE_DELAY });
        const ch = ctx.channels;
        const upmix = (mono: Float32Array): Float32Array => {
          if (ch === 1) return mono;
          const out = new Float32Array(mono.length * ch);
          for (let i = 0; i < mono.length; i++) for (let c = 0; c < ch; c++) out[i * ch + c] = mono[i]!;
          return out;
        };
        return {
          async process(input) {
            const frames = input.length / ch;
            const mono = new Float32Array(frames);
            for (let i = 0; i < frames; i++) {
              let s = 0;
              for (let c = 0; c < ch; c++) s += input[i * ch + c]!;
              mono[i] = s / ch;
            }
            return upmix(await st.push(mono));
          },
          async flush() {
            return upmix(await st.flush());
          },
        };
      },
    },
  });
}
