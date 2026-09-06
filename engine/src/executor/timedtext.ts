/**
 * Timed-text serialization [G3] — cues → WebVTT (with inline word timestamps,
 * the [R1] karaoke form parseVtt round-trips) or SRT. The engine-side twin of
 * the transcribe runtime's serializer; artifacts serialize once, at the
 * delivery edge.
 */

import type { Cue } from './vtt';

function parts(seconds: number): { h: string; m: string; s: string; ms: string } {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return {
    h: pad(Math.floor(total / 3_600_000), 2),
    m: pad(Math.floor(total / 60_000) % 60, 2),
    s: pad(Math.floor(total / 1000) % 60, 2),
    ms: pad(total % 1000, 3),
  };
}

const vttTs = (t: number) => { const p = parts(t); return `${p.h}:${p.m}:${p.s}.${p.ms}`; };
const srtTs = (t: number) => { const p = parts(t); return `${p.h}:${p.m}:${p.s},${p.ms}`; };

export function cuesToVtt(cues: Cue[]): string {
  if (!cues.length) return 'WEBVTT\n';
  return 'WEBVTT\n\n' + cues.map((c) => {
    const body = c.wordTiming && c.words.length
      ? c.words.map((w, i) => (i === 0 ? w.text : `<${vttTs(w.start)}>${w.text}`)).join(' ')
      : c.text;
    return `${vttTs(c.start)} --> ${vttTs(c.end)}\n${body}`;
  }).join('\n\n') + '\n';
}

export function cuesToSrt(cues: Cue[]): string {
  if (!cues.length) return '';
  return cues.map((c, i) => `${i + 1}\r\n${srtTs(c.start)} --> ${srtTs(c.end)}\r\n${c.text}`)
    .join('\r\n\r\n') + '\r\n';
}
