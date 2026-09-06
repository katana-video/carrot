// Tier-1 [L] translate runtime tests. Pure logic (routing, batching, pivot
// mechanics via a mock engine) plus one live OPUS-MT en→es run (~40 MB q8
// download on first run). Bergamot is browser-worker-shaped and gets its
// verification in the headed-Chrome harness (phase 2/4), behind the same
// TranslationModel interface tested here.
import { describe, it, expect } from 'vitest'
import { resolveTranslationRoute, opusMtModelId } from '../src/translate/route'
import { batchSegmentTexts, translateTranscriptSegments, type TranslationModel } from '../src/translate/translateSegments'
import { opusMtModel } from '../src/translate/opus'
import type { TranscriptSegment } from '../src/whisper/types'

const seg = (id: number, text: string, start: number, end: number): TranscriptSegment => ({
  id, text, start, end,
  words: [{ text, start, end }],
})

describe('translation routing [L3]', () => {
  it('direct pair when the registry has it', () => {
    const r = resolveTranslationRoute('en', 'es')
    expect(r.usesPivot).toBe(false)
    expect(r.pairs.map(p => p.modelId)).toEqual(['Xenova/opus-mt-en-es'])
  })

  it('pivots through English for exotic pairs', () => {
    const r = resolveTranslationRoute('ja', 'ko')
    expect(r.usesPivot).toBe(true)
    expect(r.pairs.map(p => p.modelId)).toEqual([opusMtModelId('ja', 'en'), opusMtModelId('en', 'ko')])
  })

  it('same language is a no-op route', () => {
    expect(resolveTranslationRoute('fr', 'fr').pairs).toEqual([])
  })
})

describe('segment batching + pivot mechanics [L2]', () => {
  it('batches by character budget preserving order', () => {
    const segs = [seg(1, 'a'.repeat(500), 0, 1), seg(2, 'b'.repeat(500), 1, 2), seg(3, 'c', 2, 3)]
    const batches = batchSegmentTexts(segs, 900)
    expect(batches.map(b => b.texts.length)).toEqual([1, 2])
    expect(batches[1].startIndex).toBe(1)
  })

  it('runs every batch through every hop, preserves timings, drops word timings', async () => {
    const calls: string[][] = []
    const mock: TranslationModel = {
      async translate(texts, pair) {
        calls.push([pair.modelId, ...texts])
        return texts.map(t => `[${pair.target}]${t}`)
      },
    }
    const segs = [seg(1, 'hello', 0, 1.5), seg(2, 'world', 1.5, 3)]
    const out = await translateTranscriptSegments(segs, { sourceLanguage: 'ja', targetLanguage: 'ko' }, mock)
    expect(calls.length).toBe(2)                          // one batch × two hops
    expect(calls[0][0]).toBe('Xenova/opus-mt-ja-en')
    expect(calls[1][0]).toBe('Xenova/opus-mt-en-ko')
    expect(out.map(s => s.text)).toEqual(['[ko][en]hello', '[ko][en]world'])
    expect(out.map(s => [s.start, s.end])).toEqual([[0, 1.5], [1.5, 3]])
    expect(out.every(s => s.words.length === 0)).toBe(true)
    expect(segs[0].words.length).toBe(1)                  // input untouched
  })

  it('rejects a line-count mismatch from the engine', async () => {
    const bad: TranslationModel = { async translate(texts) { return texts.slice(1) } }
    await expect(
      translateTranscriptSegments([seg(1, 'a', 0, 1), seg(2, 'b', 1, 2)],
        { sourceLanguage: 'en', targetLanguage: 'es' }, bad),
    ).rejects.toThrow(/returned 1 lines for 2/)
  })
})

describe('live OPUS-MT engine (Node cpu)', () => {
  it('translates cue text en→es preserving timings', { timeout: 600_000 }, async () => {
    const segs = [
      seg(1, 'This is the first sentence.', 0.34, 2.0),
      seg(2, 'And here comes a second sentence after a pause.', 3.36, 6.0),
    ]
    const out = await translateTranscriptSegments(
      segs, { sourceLanguage: 'en', targetLanguage: 'es' }, opusMtModel('cpu'),
    )
    const text = out.map(s => s.text).join(' ').toLowerCase()
    console.log('es:', out.map(s => s.text))
    expect(text).toMatch(/primera|primer/)                // "first"
    expect(text).toMatch(/segunda|segundo/)               // "second"
    expect(out.map(s => [s.start, s.end])).toEqual([[0.34, 2.0], [3.36, 6.0]])
  })
})
