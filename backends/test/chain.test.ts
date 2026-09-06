// The tier-1 deriver chain end-to-end in Node: speech → transcribe [R] →
// translate [L] → VTT — exactly the operation pipeline the IR expresses as
// transcribe(a1) → translate(caps) → deliver. Models come from the caches
// the per-capability tests warm.
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav } from './helpers/wav'
import { transcribe } from '../src/whisper/transcriber'
import { toVTT } from '../src/whisper/srt'
import { translateTranscriptSegments } from '../src/translate/translateSegments'
import { opusMtModel } from '../src/translate/opus'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/speech/two_sentences.wav')

describe('deriver chain: transcribe → translate → VTT', () => {
  it('produces Spanish cues on the English speech timings', { timeout: 600_000 }, async () => {
    const { samples } = readWav(fixture)
    const en = await transcribe(samples, { model: 'base', language: 'en' })
    expect(en.length).toBeGreaterThanOrEqual(2)

    const es = await translateTranscriptSegments(
      en, { sourceLanguage: 'en', targetLanguage: 'es' }, opusMtModel('cpu'),
    )
    expect(es.map(s => [s.start, s.end])).toEqual(en.map(s => [s.start, s.end]))
    expect(es.map(s => s.text.toLowerCase()).join(' ')).toMatch(/primera|primer/)

    const vtt = toVTT(es)
    console.log(vtt)
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> /)
    expect(vtt).not.toMatch(/<\d{2}/)   // no karaoke marks on translated cues [L2]
  })
})
