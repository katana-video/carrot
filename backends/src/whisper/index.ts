/**
 * Transcribe deriver — `@katana-video/carrot-backends/whisper`.
 *
 * The engine's `transcribe` step [R]: 16 kHz mono PCM is extracted from the
 * source with Mediabunny (streaming, ~4 MB/min peak), then whisper runs via
 * transformers.js (`onnx-community/whisper-{tiny,base,small}_timestamped`
 * from the Hugging Face hub, WebGPU first with a wasm fallback) and returns
 * cues with word timings. transformers.js is an optional peer, imported on
 * first use; nothing model-sized loads until a transcription runs.
 */
import {
  ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WavOutputFormat,
} from 'mediabunny';
import type { Cue, DeriverBackends } from '@katana-video/carrot';
import { applyTransformersWeightsBase } from '../weights';

export { WHISPER_MODELS, type WhisperModelId, type TranscriptSegment, type TranscriptWord } from './types';
export { transcribe as transcribePcm, SAMPLE_RATE, type TranscribeOptions, type TranscribeDevice } from './transcriber';
export { segmentWords } from './segment';
export { toSRT, toVTT } from './srt';

/** 16 kHz mono f32 PCM via mediabunny (streaming). */
export async function extractPcm16k(blob: Blob): Promise<Float32Array> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const target = new BufferTarget();
  const output = new Output({ format: new WavOutputFormat(), target });
  const conversion = await Conversion.init({
    input, output,
    video: { discard: true },
    audio: { codec: 'pcm-f32', sampleRate: 16000, numberOfChannels: 1 },
  });
  await conversion.execute();
  const buf = target.buffer!;
  const view = new DataView(buf);
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    const size = view.getUint32(off + 4, true);
    if (id === 'data') return new Float32Array(buf, off + 8, size / 4);
    off += 8 + size + (size & 1);
  }
  throw new Error('pcm extraction produced no data chunk');
}

const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

/** The `transcribe` deriver: pass in `createWorkerHost({ derivers: { transcribe } })`. */
export const transcribe: NonNullable<DeriverBackends['transcribe']> = async (source, params, ctx) => {
  await applyTransformersWeightsBase();
  const { transcribe: whisperTranscribe } = await import('./transcriber');
  const pcm = await extractPcm16k(source);
  const opts = {
    model: params.model as 'tiny' | 'base' | 'small',
    ...(params.language ? { language: params.language } : {}),
  };
  const progress = {
    ...(ctx.onModelProgress ? { onDownload: ctx.onModelProgress } : {}),
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  };
  let segments;
  try {
    segments = await whisperTranscribe(pcm, { ...opts, ...progress, device: hasWebGpu ? 'webgpu' : 'wasm' });
  } catch {
    segments = await whisperTranscribe(pcm, { ...opts, ...progress, device: 'wasm' });
  }
  return segments.map((s): Cue => ({
    start: s.start, end: s.end, text: s.text,
    words: s.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    wordTiming: s.words.length > 0,
  }));
};
