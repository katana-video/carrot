// Tier-1 [R] transcribe runtime — whisper via @huggingface/transformers,
// adapted from the Katana frontend's transcribe.worker.ts: same models, same
// chunking, same word-timestamp harvesting, but a plain async function
// instead of a worker (the engine's phase-2 executor wraps it back into a
// worker; the browser build passes device 'webgpu'→'wasm', Node uses 'cpu').
import { env, pipeline, WhisperTextStreamer } from '@huggingface/transformers'
import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { WHISPER_MODELS, type TranscriptSegment, type TranscriptWord, type WhisperModelId } from './types'
import { segmentWords } from './segment'

env.allowLocalModels = false

export const SAMPLE_RATE = 16000
const CHUNK_LENGTH_S = 30
const STRIDE_LENGTH_S = 5

export type TranscribeDevice = 'cpu' | 'wasm' | 'webgpu'

export interface TranscribeOptions {
  model?: WhisperModelId
  /** ISO 639-1 code; omit for auto-detect */
  language?: string
  device?: TranscribeDevice
  onDownload?: (loaded: number, total: number) => void
  /** Inference progress 0..1 — derived from the whisper streamer's chunk
   * timestamps (seconds of audio decoded / total), the frontend's approach. */
  onProgress?: (fraction: number) => void
}

const cache = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>()

function loadPipeline(model: WhisperModelId, device: TranscribeDevice, onDownload?: TranscribeOptions['onDownload']) {
  const key = `${model}:${device}`
  let entry = cache.get(key)
  if (!entry) {
    entry = pipeline('automatic-speech-recognition', WHISPER_MODELS[model].hfId, {
      device,
      dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: (info) => {
        if (info.status === 'progress_total' && onDownload) onDownload(info.loaded, info.total)
      },
    })
    cache.set(key, entry)
    entry.catch(() => cache.delete(key))
  }
  return entry
}

/** Transcribe 16 kHz mono f32 PCM into subtitle-shaped segments with word timings. */
export async function transcribe(audio: Float32Array, opts: TranscribeOptions = {}): Promise<TranscriptSegment[]> {
  const model = opts.model ?? 'base'
  const device = opts.device ?? 'cpu'
  const asr = await loadPipeline(model, device, opts.onDownload)

  // Progress: whisper walks the audio in 30 s windows with 5 s strides; the
  // streamer's chunk timestamps give audio-seconds-decoded. Capped at 0.99 —
  // 1.0 is emitted only after the final result exists.
  let streamer: WhisperTextStreamer | undefined
  if (opts.onProgress) {
    const report = opts.onProgress
    const durationS = audio.length / SAMPLE_RATE
    const jumpS = CHUNK_LENGTH_S - 2 * STRIDE_LENGTH_S
    const totalChunks = durationS <= CHUNK_LENGTH_S ? 1 : 1 + Math.ceil((durationS - CHUNK_LENGTH_S) / jumpS)
    let chunksDone = 0
    streamer = new WhisperTextStreamer(asr.tokenizer as ConstructorParameters<typeof WhisperTextStreamer>[0], {
      skip_prompt: true,
      on_chunk_end: (time: number) => {
        const fraction = durationS > 0 ? (chunksDone * jumpS + time) / durationS : 0
        report(Math.min(fraction, (chunksDone + 1) / totalChunks, 0.99))
      },
      on_finalize: () => {
        chunksDone += 1
        report(Math.min(chunksDone / totalChunks, 0.99))
      },
    })
    report(0)
  }

  const output = await asr(audio, {
    chunk_length_s: CHUNK_LENGTH_S,
    stride_length_s: STRIDE_LENGTH_S,
    return_timestamps: 'word',
    task: 'transcribe',
    ...(opts.language ? { language: opts.language } : {}),
    ...(streamer ? { streamer } : {}),
  })
  opts.onProgress?.(1)

  const result = Array.isArray(output) ? output[0] : output
  const words: TranscriptWord[] = []
  for (const chunk of result.chunks ?? []) {
    const text = chunk.text.trim()
    if (!text) continue
    const [start, end] = chunk.timestamp
    const s = typeof start === 'number' && Number.isFinite(start) ? start : words.length > 0 ? words[words.length - 1]!.end : 0
    const e = typeof end === 'number' && Number.isFinite(end) ? end : s
    words.push({ text, start: s, end: Math.max(e, s) })
  }

  let segments = segmentWords(words)
  if (segments.length === 0 && result.text.trim()) {
    segments = [{ id: 1, text: result.text.trim(), start: 0, end: audio.length / SAMPLE_RATE, words: [] }]
  }
  return segments
}
