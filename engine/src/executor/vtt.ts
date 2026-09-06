/**
 * Minimal WebVTT parser for burn-in [O5] — cues with optional inline word
 * timestamps (`Hello <00:00:01.500>world`), the standard VTT karaoke form and
 * exactly the word-level timing model the caption renderer wants.
 *
 * Deliberately lenient: header optional, cue ids/settings ignored, styling
 * tags (<c>, <b>, …) stripped. Malformed timing lines are skipped, not fatal.
 */

export interface CueWord {
  text: string;
  start: number;
  end: number;
}

export interface Cue {
  start: number;
  end: number;
  /** Plain text, tags stripped, lines joined with spaces. */
  text: string;
  words: CueWord[];
  /** True when the cue carried inline timestamps (karaoke effects enabled). */
  wordTiming: boolean;
}

const TS = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;

function parseTs(s: string): number | null {
  const m = TS.exec(s);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (!lines.length) continue;
    let i = 0;
    if (/^WEBVTT/.test(lines[0]!) || /^(NOTE|STYLE|REGION)/.test(lines[0]!)) continue;
    if (!lines[i]!.includes('-->')) i++;             // optional cue id line
    const timing = lines[i];
    if (!timing?.includes('-->')) continue;
    const [a, b] = timing.split('-->');
    const start = parseTs(a ?? ''), end = parseTs(b ?? '');
    if (start == null || end == null || end <= start) continue;

    const payload = lines.slice(i + 1).join(' ');
    // split on inline timestamps, keeping them: [text, ts, text, ts, ...]
    const parts = payload.split(/<((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3})>/);
    const words: CueWord[] = [];
    const wordTiming = parts.length > 1;
    let segStart = start;
    for (let p = 0; p < parts.length; p += 2) {
      const segEnd = p + 1 < parts.length ? (parseTs(parts[p + 1]!) ?? end) : end;
      const seg = parts[p]!.replace(/<[^>]*>/g, '');   // strip styling tags
      const segWords = seg.split(/\s+/).filter(Boolean);
      // words inside one segment share its timing (finer timing needs more stamps)
      for (const w of segWords) words.push({ text: w, start: segStart, end: segEnd });
      segStart = segEnd;
    }
    if (!words.length) continue;
    cues.push({
      start, end,
      text: words.map((w) => w.text).join(' '),
      words, wordTiming,
    });
  }
  return cues;
}
