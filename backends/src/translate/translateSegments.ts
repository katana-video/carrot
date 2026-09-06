// Segment-preserving translation [L2] — from the frontend's
// translateSegments.ts: batch cue texts (~900 chars), run each batch through
// every hop of the route, re-attach translated text with timings untouched.
// The engine is pluggable (TranslationModel): OPUS-MT in Node/fallback,
// Bergamot in the browser.
import type { TranscriptSegment } from '../whisper/types'
import { resolveTranslationRoute, type TranslateLanguageCode, type TranslationPair } from './route'

export interface TranslationModel {
  translate(texts: string[], pair: TranslationPair): Promise<string[]>
}

export interface TranslateSegmentsOptions {
  sourceLanguage: TranslateLanguageCode
  targetLanguage: TranslateLanguageCode
  maxBatchChars?: number
  signal?: AbortSignal
  onProgress?: (translated: number, total: number) => void
}

interface SegmentBatch {
  startIndex: number
  texts: string[]
}

export function batchSegmentTexts(segments: TranscriptSegment[], maxBatchChars = 900): SegmentBatch[] {
  const batches: SegmentBatch[] = []
  let current: SegmentBatch | null = null
  let currentChars = 0

  segments.forEach((segment, index) => {
    const text = segment.text.trim()
    const chars = Math.max(text.length, 1)
    if (!current || (current.texts.length > 0 && currentChars + chars > maxBatchChars)) {
      current = { startIndex: index, texts: [] }
      batches.push(current)
      currentChars = 0
    }
    current.texts.push(text)
    currentChars += chars
  })

  return batches
}

export async function translateTranscriptSegments<T extends TranscriptSegment>(
  segments: T[],
  opts: TranslateSegmentsOptions,
  model: TranslationModel,
): Promise<T[]> {
  opts.signal?.throwIfAborted()
  if (segments.length === 0 || opts.sourceLanguage === opts.targetLanguage) {
    opts.onProgress?.(segments.length, segments.length)
    return segments.map(seg => ({ ...seg }))
  }

  const route = resolveTranslationRoute(opts.sourceLanguage, opts.targetLanguage)
  const translatedTexts = segments.map(seg => seg.text)
  const batches = batchSegmentTexts(segments, opts.maxBatchChars)
  let translatedCount = 0
  opts.onProgress?.(0, segments.length)

  for (const batch of batches) {
    opts.signal?.throwIfAborted()
    let texts = batch.texts
    for (const routePair of route.pairs) {
      opts.signal?.throwIfAborted()
      texts = await model.translate(texts, routePair)
      if (texts.length !== batch.texts.length) {
        throw new Error(`Translation model returned ${texts.length} lines for ${batch.texts.length} input lines`)
      }
    }
    texts.forEach((text, offset) => {
      translatedTexts[batch.startIndex + offset] = text.trim()
    })
    translatedCount += batch.texts.length
    opts.onProgress?.(translatedCount, segments.length)
  }

  // Translated cue text no longer maps onto source-language word timings, so
  // per-word karaoke data is dropped; cue-level timings pass through [L2].
  return segments.map((segment, index) => ({ ...segment, text: translatedTexts[index], words: [] }))
}
