// Tier-1 [R] transcribe types — adapted from the Katana frontend's
// src/tools/transcribe/types.ts (same company; see tier1-capabilities-plan).
export type WhisperModelId = 'tiny' | 'base' | 'small'

export interface ModelInfo {
  id: WhisperModelId
  /** Hugging Face repo id passed to @huggingface/transformers */
  hfId: string
  approxSizeMB: number
}

// The _timestamped exports include cross-attention outputs, which
// return_timestamps: 'word' requires — the plain exports throw at inference.
export const WHISPER_MODELS: Record<WhisperModelId, ModelInfo> = {
  tiny: { id: 'tiny', hfId: 'onnx-community/whisper-tiny_timestamped', approxSizeMB: 120 },
  base: { id: 'base', hfId: 'onnx-community/whisper-base_timestamped', approxSizeMB: 200 },
  small: { id: 'small', hfId: 'onnx-community/whisper-small_timestamped', approxSizeMB: 600 },
}

export interface TranscriptWord {
  text: string
  /** Seconds from start of media */
  start: number
  end: number
}

export interface TranscriptSegment {
  id: number
  text: string
  /** Seconds from start of media */
  start: number
  end: number
  words: TranscriptWord[]
}
