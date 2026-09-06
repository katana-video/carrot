// Tier-1 [R] transcribe runtime tests — whisper-base over flite-synthesized
// fixtures with known scripts. TTS + base-model quirks are real (it hears
// "round" for flite's "brown"), so text assertions target the reliably-heard
// words, and the strong assertions are structural: word-timestamp sanity,
// cue segmentation at the sentence/pause boundary, VTT/SRT serialization.
// First run downloads whisper-base (~200 MB) into the HF cache.
import { describe, it, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWav } from './helpers/wav'
import { transcribe, SAMPLE_RATE } from '../src/whisper/transcriber'
import { segmentWords } from '../src/whisper/segment'
import { toSRT, toVTT } from '../src/whisper/srt'
import type { TranscriptSegment } from '../src/whisper/types'

const dir = dirname(fileURLToPath(import.meta.url))
const fixture = (f: string) => join(dir, 'fixtures', 'speech', f)

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, '')

let fox: TranscriptSegment[] | null = null
export const foxProgress: number[] = []
async function foxSegments(): Promise<TranscriptSegment[]> {
  if (!fox) {
    const { samples } = readWav(fixture('speech.wav'))
    fox = await transcribe(samples, {
      model: 'base', language: 'en',
      onProgress: (f) => foxProgress.push(f),
    })
  }
  return fox
}

describe('transcribe runtime (whisper-base, Node cpu)', () => {
  it('hears the fox sentence with sane word timings', { timeout: 600_000 }, async () => {
    const { samples } = readWav(fixture('speech.wav'))
    const durationS = samples.length / SAMPLE_RATE
    const segs = await foxSegments()
    const text = norm(segs.map(s => s.text).join(' '))
    for (const w of ['quick', 'fox', 'jumps', 'lazy']) expect(text).toContain(w)

    const words = segs.flatMap(s => s.words)
    expect(words.length).toBeGreaterThanOrEqual(6)
    let prev = 0
    for (const w of words) {
      expect(w.start).toBeGreaterThanOrEqual(prev - 0.01)  // monotonic
      expect(w.end).toBeGreaterThanOrEqual(w.start)
      expect(w.end).toBeLessThanOrEqual(durationS + 0.5)
      prev = w.start
    }
  })

  it('splits two sentences around the silence gap', { timeout: 600_000 }, async () => {
    const { samples } = readWav(fixture('two_sentences.wav'))
    const segs = await transcribe(samples, { model: 'base', language: 'en' })
    expect(segs.length).toBeGreaterThanOrEqual(2)
    expect(norm(segs[0].text)).toContain('first')
    expect(norm(segs.map(s => s.text).join(' '))).toContain('second')
    // The fixture has ~1.2 s of silence from ~2.1 s; no cue may span it.
    for (const s of segs) expect(s.start > 3 || s.end < 3.4).toBe(true)
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end - 0.01)
  })

  it('serializes VTT with inline word timestamps, and SRT', async () => {
    const segs = await foxSegments()
    const vtt = toVTT(segs)
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true)
    expect(vtt).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/)
    expect(vtt).toMatch(/<\d{2}:\d{2}:\d{2}\.\d{3}>/)          // [R1] karaoke form
    expect(toVTT(segs, { wordTimestamps: false })).not.toMatch(/</)
    const srt = toSRT(segs)
    expect(srt).toMatch(/^1\r\n\d{2}:\d{2}:\d{2},\d{3} --> /)
  })

  it('segmentWords is deterministic and subtitle-shaped (no model needed)', () => {
    const words = Array.from({ length: 40 }, (_, i) => ({
      text: i === 19 ? 'sentence.' : `word${i}`,
      start: i * 0.4,
      end: i * 0.4 + 0.3,
    }))
    const segs = segmentWords(words)
    expect(segs.length).toBeGreaterThan(1)
    for (const s of segs) {
      expect(s.text.length).toBeLessThanOrEqual(42 + 12)      // maxChars + one overflow word
      expect(s.end - s.start).toBeLessThanOrEqual(5 + 0.75)   // maxDuration + one word
    }
    // Sentence end must win as the break point.
    expect(segs.some(s => s.text.endsWith('sentence.'))).toBe(true)
  })
})

describe('transcription progress stream', () => {
  it('reports monotonic 0..1 fractions ending at 1', { timeout: 600_000 }, async () => {
    await foxSegments()
    expect(foxProgress.length).toBeGreaterThanOrEqual(2)
    expect(foxProgress[0]).toBe(0)
    expect(foxProgress[foxProgress.length - 1]).toBe(1)
    for (let i = 1; i < foxProgress.length; i++) {
      expect(foxProgress[i]).toBeGreaterThanOrEqual(foxProgress[i - 1]!)
    }
  })
})
