/**
 * Whole-output model kernels [U3, H3] — resolved from the host-registered op
 * registry (the engine core carries no model runtimes; hosts register
 * 'upscale'/'denoise' OpDefs whose creators wrap websr / the longpipe wasm).
 *
 * Integration shape: the kernels wrap the encoder-facing sources. Video: each
 * composed VideoSample runs frame→frame through the transform (composite at
 * plan.compositeCanvas, encode at plan.canvas). Audio: ONE streaming instance
 * spans the whole output — samples are interleaved, pushed through, and
 * re-emitted on a running output clock (model latency shifts samples, flush
 * drains the tail; the [H3] delay trim happens inside the backend).
 */

import { AudioSample, VideoSample } from 'mediabunny';
import {
  getOp, type AudioStreamTransform, type Backend, type CompiledPlan, type FrameTransform,
} from '../schema';
import { extractPlanar, planarSample } from '../nodes/audio';

export function resolveBackend(backend: Backend | 'auto'): Backend {
  if (backend !== 'auto') return backend;
  return typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'webgl2';
}

/** Look up + instantiate the plan's video kernel chain. Throws when a kernel
 * is unregistered or lacks this backend — honest capability failure. */
export async function createVideoKernel(
  plan: CompiledPlan,
  backend: Backend,
): Promise<FrameTransform | null> {
  const decls = plan.videoKernels;
  if (!decls?.length) return null;
  const transforms: FrameTransform[] = [];
  for (const d of decls) {
    const def = getOp(d.op);
    if (!def || def.lower.family !== 'kernel') {
      throw new Error(`video kernel '${d.op}' is not registered on this host`);
    }
    const create = def.lower.backends[backend];
    if (!create) throw new Error(`video kernel '${d.op}' has no ${backend} backend`);
    transforms.push(await create(d.params, { backend, geometry: d.params.from }));
  }
  if (transforms.length === 1) return transforms[0]!;
  return async (frame, t) => {
    let f = frame;
    for (const tr of transforms) f = await tr(f, t);
    return f;
  };
}

/** True when any of the plan's audio kernels asked for the whole-lane peak. */
export function audioKernelsNeedPeak(plan: CompiledPlan): boolean {
  return (plan.audioKernels ?? []).some((d) => {
    const def = getOp(d.op);
    return def?.lower.family === 'audio-kernel' && def.lower.prepass === 'peak';
  });
}

export async function createAudioKernel(
  plan: CompiledPlan,
  ctx: { rate: number; channels: number; peak?: number },
): Promise<AudioStreamTransform | null> {
  const decls = plan.audioKernels;
  if (!decls?.length) return null;
  const stages: AudioStreamTransform[] = [];
  for (const d of decls) {
    const def = getOp(d.op);
    if (!def || def.lower.family !== 'audio-kernel') {
      throw new Error(`audio kernel '${d.op}' is not registered on this host`);
    }
    stages.push(await def.lower.create(d.params, ctx));
  }
  if (stages.length === 1) return stages[0]!;
  return {
    async process(input) {
      let x = input;
      for (const s of stages) x = await s.process(x);
      return x;
    },
    async flush() {
      let x: Float32Array = new Float32Array(0);
      for (const s of stages) {
        const processed = x.length ? await s.process(x) : new Float32Array(0);
        const tail = await s.flush();
        x = concatF32(processed, tail);
      }
      return x;
    },
  };
}

const concatF32 = (a: Float32Array, b: Float32Array): Float32Array => {
  if (!a.length) return b;
  if (!b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
};

interface VideoSink { add(sample: VideoSample, opts?: unknown): Promise<void> | void; close?(): void }

/** Wrap a video sink so every composed sample passes through the kernel. */
export function kernelVideoSink<T extends VideoSink>(
  inner: T,
  transform: FrameTransform,
): { add(sample: VideoSample): Promise<void>; close(): void } {
  return {
    close: () => inner.close?.(),
    async add(sample: VideoSample) {
      // the frame may be backed by the sample — keep the sample alive until
      // the transform has produced an independent output frame
      const frame = sample.toVideoFrame();
      const timestamp = sample.timestamp;
      const duration = sample.duration;
      const out = await transform(frame, timestamp);
      if (out !== frame) frame.close();
      sample.close();
      // VideoSample wraps the frame by reference — closing the sample after
      // add() closes the frame; closing the frame early breaks the encoder's
      // lazy toVideoFrame().
      const outSample = new VideoSample(out, { timestamp, duration });
      await inner.add(outSample);
      outSample.close();
      out.close();
    },
  };
}

interface AudioSink { add(sample: AudioSample): Promise<void> | void; close?(): void }

/** Wrap an audio sink with the streaming kernel. Samples re-emit on a running
 * output clock starting at the first input's timestamp (audio output is
 * contiguous from 0 by construction; latency only shifts the split points).
 * Call flush() before closing the underlying source. */
export function kernelAudioSink(
  inner: AudioSink,
  transform: AudioStreamTransform,
  fmt: { rate: number; channels: number },
): { add(sample: AudioSample): Promise<void>; flush(): Promise<void> } {
  let outCursor: number | null = null;

  const emit = async (data: Float32Array) => {
    if (!data.length || outCursor === null) return;
    const frames = data.length / fmt.channels;
    const chans: Float32Array[] = [];
    for (let c = 0; c < fmt.channels; c++) {
      const ch = new Float32Array(frames);
      for (let i = 0; i < frames; i++) ch[i] = data[i * fmt.channels + c]!;
      chans.push(ch);
    }
    const s = planarSample(chans, fmt.rate, outCursor);
    outCursor += frames / fmt.rate;
    try {
      await inner.add(s);
    } finally {
      // the encoder copies on add — leaving these open leaks one sample per
      // emission (mediabunny GC warnings; long files exhaust the platform's
      // audio-buffer pool and the pipeline wedges mid-run)
      s.close();
    }
  };

  return {
    async add(sample: AudioSample) {
      if (outCursor === null) outCursor = sample.timestamp;
      const planar = extractPlanar(sample, fmt.channels);
      sample.close();
      const frames = planar[0]!.length;
      const inter = new Float32Array(frames * fmt.channels);
      for (let c = 0; c < fmt.channels; c++) {
        const ch = planar[c]!;
        for (let i = 0; i < frames; i++) inter[i * fmt.channels + c] = ch[i]!;
      }
      await emit(await transform.process(inter));
    },
    async flush() {
      await emit(await transform.flush());
    },
  };
}
