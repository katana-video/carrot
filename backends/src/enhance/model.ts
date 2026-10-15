/**
 * The VoiceFixer ONNX session (ONNX_INTEGRATION.md §3) on onnxruntime-web's
 * WebGPU EP. ORT loads from a PINNED CDN build — a silent minor upgrade has
 * changed numbers before — so this package takes no npm dependency on it;
 * hosts can point `ortUrl` at a self-hosted copy of the same file.
 *
 * Rules that bite (§6/§7): WebGPU is required (no usable wasm fallback);
 * `graphOptimizationLevel: 'all'` folds the fp16 storage casts (no
 * shader-f16 needed); `preferredOutputLocation: 'cpu'` so run() resolves only
 * when results are readable; the first run autotunes, so warm up on silence.
 */
import { CHUNK_IN } from './stitch';

export const ORT_VERSION = '1.23.2';
export const DEFAULT_ORT_URL =
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.webgpu.bundle.min.mjs`;

/** The graph records its external-data location by this exact name. */
export const GRAPH_FILE = 'chunk_3s_w16.onnx';
export const WEIGHTS_FILE = 'chunk_3s_w16_weights.bin';

/** Minimal slice of the onnxruntime-web API this backend touches. */
interface OrtLike {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(model: ArrayBuffer | Uint8Array, opts: Record<string, unknown>): Promise<{
      run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
      release(): Promise<void>;
    }>;
  };
}

export interface VoiceFixerSession {
  /** CHUNK_IN samples @ 44.1 kHz in, CHUNK_OUT out. Calls serialize. */
  run(x: Float32Array): Promise<Float32Array>;
  release(): Promise<void>;
}

/** WebGPU present AND an adapter obtainable — the real requirement. */
export async function enhanceSupported(): Promise<boolean> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: GPU } | undefined)?.gpu;
  if (!gpu) return false;
  try { return !!(await gpu.requestAdapter()); } catch { return false; }
}

export async function createVoiceFixerSession(
  bytes: { graph: ArrayBuffer; weights: ArrayBuffer },
  opts: { ortUrl?: string } = {},
): Promise<VoiceFixerSession> {
  if (!(await enhanceSupported())) {
    throw new Error('Voice enhancement needs WebGPU, which this browser or device does not provide');
  }
  const ort = await import(/* @vite-ignore */ opts.ortUrl ?? DEFAULT_ORT_URL) as OrtLike;
  const session = await ort.InferenceSession.create(bytes.graph, {
    executionProviders: ['webgpu'],
    graphOptimizationLevel: 'all',
    externalData: [{ path: WEIGHTS_FILE, data: bytes.weights }],
    preferredOutputLocation: 'cpu',
    logSeverityLevel: 3,
  });
  let queue: Promise<unknown> = Promise.resolve();
  const runOnce = async (x: Float32Array): Promise<Float32Array> => {
    const out = await session.run({ wav: new ort.Tensor('float32', x, [1, CHUNK_IN]) });
    // .dims are symbolic in the graph — trust .data (§7.4)
    return new Float32Array(out.audio!.data);
  };
  // warm-up: the first run autotunes (~1.4× a steady run) — pay it on silence
  await runOnce(new Float32Array(CHUNK_IN));
  return {
    run(x) {
      const p = queue.then(() => runOnce(x));
      queue = p.catch(() => {});
      return p;
    },
    release: () => session.release(),
  };
}
