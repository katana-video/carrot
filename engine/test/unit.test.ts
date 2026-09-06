import { describe, expect, it } from 'vitest';
import { resolveRange, resolveTime, resolveSpace, resolveVolume } from '../src/ir/scalars';
import { normalize } from '../src/ir/normalize';
import { parseVtt } from '../src/executor/vtt';

describe('vtt parser [O5]', () => {
  it('parses plain cues, strips tags, joins lines', () => {
    const cues = parseVtt([
      'WEBVTT', '',
      '00:00:01.000 --> 00:00:03.000', 'Hello <b>subtitles</b>', 'second line', '',
      'cue-2', '00:05.000 --> 00:07.000', 'Second cue', '',
    ].join('\n'));
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ start: 1, end: 3, text: 'Hello subtitles second line', wordTiming: false });
    expect(cues[0]!.words.every((w) => w.start === 1 && w.end === 3)).toBe(true);
    expect(cues[1]).toMatchObject({ start: 5, end: 7, text: 'Second cue' });
  });

  it('inline timestamps produce word-level timing (karaoke form)', () => {
    const cues = parseVtt('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nOne <00:00:02.000>two <00:00:03.000>three');
    expect(cues[0]!.wordTiming).toBe(true);
    expect(cues[0]!.words).toEqual([
      { text: 'One', start: 1, end: 2 },
      { text: 'two', start: 2, end: 3 },
      { text: 'three', start: 3, end: 4 },
    ]);
  });

  it('skips malformed blocks and NOTE/STYLE sections without failing', () => {
    const cues = parseVtt('WEBVTT\n\nNOTE a comment\n\ngarbage\n\n00:00:01.000 --> 00:00:00.500\nbackwards\n\n00:00:01.000 --> 00:00:02.000\nok');
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('ok');
  });
});

describe('symbolic scalars [S1-S3]', () => {
  it('resolves literals, symbols, negatives, percents', () => {
    expect(resolveTime(5, 20)).toBe(5);
    expect(resolveTime(-5, 20)).toBe(15);           // last 5 seconds
    expect(resolveTime('start', 20)).toBe(0);
    expect(resolveTime('end', 20)).toBe(20);
    expect(resolveTime('50%', 20)).toBe(10);
    expect(resolveTime('-25%', 20)).toBe(15);
    expect(resolveSpace('50%', 320)).toBe(160);
    expect(resolveSpace(8, 320)).toBe(8);
    expect(resolveVolume(undefined)).toBe(1);
    expect(resolveVolume('30%')).toBeCloseTo(0.3);
    expect(resolveVolume(2)).toBe(2);
  });
  it('omitted range = whole source [S3]', () => {
    expect(resolveRange(undefined, 8)).toEqual({ start: 0, end: 8 });
    expect(resolveRange({ start: 2 }, 8)).toEqual({ start: 2, end: 8 });
    expect(resolveRange({ end: -1 }, 8)).toEqual({ start: 0, end: 7 });
  });
});

const baseDoc = (timeline: unknown[], extra: Record<string, unknown> = {}) => ({
  version: '0.1',
  assets: { a: { kind: 'video' }, b: { kind: 'video' }, m: { kind: 'audio' } },
  operations: [{ id: 'out', op: 'render', timeline, output: { container: 'mp4', video: {}, audio: {} }, ...extra }],
});

describe('normalize [§12]', () => {
  it('rejects transitions not between two slots [X1]', () => {
    const r = normalize(baseDoc([
      { type: 'transition', style: 'crossfade', duration: 1 },
      { type: 'clip', source: 'a' },
    ]));
    expect(r.errors.some((e) => e.code === 'transition-placement')).toBe(true);
  });
  it('rejects unknown references', () => {
    const r = normalize(baseDoc([{ type: 'clip', source: 'nope' }]));
    expect(r.errors.some((e) => e.code === 'unknown-reference')).toBe(true);
  });
  it('rejects id collisions [P2a]', () => {
    const doc = baseDoc([{ type: 'clip', source: 'a' }]);
    (doc.operations[0] as { id: string }).id = 'a';
    expect(normalize(doc).errors.some((e) => e.code === 'id-collision')).toBe(true);
  });
  it('accepts clip.speed (Tier 0 roadmap item 3 — was unsupported-in-v01)', () => {
    const r = normalize(baseDoc([{ type: 'clip', source: 'a', speed: 2 }]));
    expect(r.errors).toEqual([]);
  });
  it('requires anchor on non-base visual layers [G2]', () => {
    const r = normalize(baseDoc([{
      type: 'composition',
      layers: [
        { type: 'video', source: 'a' },
        { type: 'video', source: 'b' },  // no place
      ],
    }]));
    expect(r.errors.some((e) => e.code === 'missing-place')).toBe(true);
  });
  it('canonicalizes one-layer video compositions to clips [C6]', () => {
    const r = normalize(baseDoc([{
      type: 'composition',
      layers: [{ type: 'video', source: 'a', range: { start: 1 }, volume: 0.5 }],
    }]));
    expect(r.errors).toEqual([]);
    const op0 = r.doc!.operations[0]!;
    if (op0.op !== 'render') throw new Error('expected render');
    const item = op0.timeline[0]!;
    expect(item.type).toBe('clip');
    if (item.type === 'clip') {
      expect(item.source).toBe('a');
      expect(item.volume).toBe(0.5);
    }
  });
  it('normalization output is canonical: same meaning, same core', () => {
    const viaClip = normalize(baseDoc([{ type: 'clip', source: 'a' }]));
    const viaComp = normalize(baseDoc([{ type: 'composition', layers: [{ type: 'video', source: 'a' }] }]));
    expect(viaComp.doc).toEqual(viaClip.doc);
  });
});
