// Word→cue segmentation — verbatim from the Katana frontend's
// src/tools/transcribe/segment.ts (subtitle-shaped cues: ≤42 chars, ≤5 s,
// break preference: sentence end > clause end > speech gap > overflow).
import type { TranscriptSegment, TranscriptWord } from './types'

export interface SegmentOptions {
  maxChars?: number
  maxDurationS?: number
  minGapS?: number
}

const SENTENCE_END = /[.!?…。？！]["')\]]*$/
const CLAUSE_END = /[,;:，、；：]["')\]]*$/

function joinedLength(words: TranscriptWord[]): number {
  return words.reduce((sum, w, i) => sum + w.text.length + (i > 0 ? 1 : 0), 0)
}

function findBreak(buffer: TranscriptWord[], next: TranscriptWord, minGapS: number): number {
  for (let k = buffer.length - 1; k >= 0; k--) {
    if (SENTENCE_END.test(buffer[k]!.text)) return k
  }
  for (let k = buffer.length - 1; k >= 0; k--) {
    if (CLAUSE_END.test(buffer[k]!.text)) return k
  }
  for (let k = buffer.length - 1; k >= 0; k--) {
    const following = k === buffer.length - 1 ? next : buffer[k + 1]!
    if (following.start - buffer[k]!.end > minGapS) return k
  }
  return buffer.length - 1
}

export function segmentWords(words: TranscriptWord[], options: SegmentOptions = {}): TranscriptSegment[] {
  const maxChars = options.maxChars ?? 42
  const maxDurationS = options.maxDurationS ?? 5
  const minGapS = options.minGapS ?? 0.3

  const cleaned: TranscriptWord[] = []
  for (const w of words) {
    const text = w.text.trim()
    if (text) cleaned.push({ text, start: w.start, end: Math.max(w.end, w.start) })
  }

  const segments: TranscriptSegment[] = []
  const emit = (segWords: TranscriptWord[]) => {
    segments.push({
      id: segments.length + 1,
      text: segWords.map(w => w.text).join(' '),
      start: segWords[0]!.start,
      end: segWords[segWords.length - 1]!.end,
      words: segWords,
    })
  }

  let buffer: TranscriptWord[] = []
  for (const word of cleaned) {
    while (buffer.length > 0) {
      const fitsChars = joinedLength(buffer) + 1 + word.text.length <= maxChars
      const fitsTime = word.end - buffer[0]!.start <= maxDurationS
      if (fitsChars && fitsTime) break
      const k = findBreak(buffer, word, minGapS)
      emit(buffer.slice(0, k + 1))
      buffer = buffer.slice(k + 1)
    }
    buffer.push(word)
  }
  if (buffer.length > 0) emit(buffer)
  return segments
}
