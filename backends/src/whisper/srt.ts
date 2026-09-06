// Timed-text serialization — from the Katana frontend's
// src/tools/transcribe/srt.ts, extended with inline word timestamps in VTT
// (`<00:00:02.000>` form) so [O5]'s karaoke treatment activates when burned
// — the [R1] contract.
import type { TranscriptSegment } from './types'

function timestampParts(seconds: number): { h: string; m: string; s: string; ms: string } {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000))
  const pad = (n: number, width: number) => String(n).padStart(width, '0')
  return {
    h: pad(Math.floor(total / 3_600_000), 2),
    m: pad(Math.floor(total / 60_000) % 60, 2),
    s: pad(Math.floor(total / 1000) % 60, 2),
    ms: pad(total % 1000, 3),
  }
}

export function formatSrtTimestamp(seconds: number): string {
  const { h, m, s, ms } = timestampParts(seconds)
  return `${h}:${m}:${s},${ms}`
}

export function formatVttTimestamp(seconds: number): string {
  const { h, m, s, ms } = timestampParts(seconds)
  return `${h}:${m}:${s}.${ms}`
}

export function toSRT(segments: TranscriptSegment[]): string {
  if (segments.length === 0) return ''
  return (
    segments
      .map((seg, i) => `${i + 1}\r\n${formatSrtTimestamp(seg.start)} --> ${formatSrtTimestamp(seg.end)}\r\n${seg.text}`)
      .join('\r\n\r\n') + '\r\n'
  )
}

export interface VttOptions {
  /** Emit inline per-word timestamps when the segments carry them. Default true. */
  wordTimestamps?: boolean
}

function cueBody(seg: TranscriptSegment, wordTimestamps: boolean): string {
  if (!wordTimestamps || seg.words.length === 0) return seg.text
  // First word is "current" from cue start — no leading timestamp; each
  // subsequent word is preceded by its start time.
  return seg.words
    .map((w, i) => (i === 0 ? w.text : `<${formatVttTimestamp(w.start)}>${w.text}`))
    .join(' ')
}

export function toVTT(segments: TranscriptSegment[], options: VttOptions = {}): string {
  const words = options.wordTimestamps ?? true
  if (segments.length === 0) return 'WEBVTT\n'
  return (
    'WEBVTT\n\n' +
    segments
      .map(seg => `${formatVttTimestamp(seg.start)} --> ${formatVttTimestamp(seg.end)}\n${cueBody(seg, words)}`)
      .join('\n\n') + '\n'
  )
}
