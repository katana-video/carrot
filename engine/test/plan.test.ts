import { describe, expect, it } from 'vitest';
import { plan, preflight } from '../src/ir/plan';
import type { FactsTable } from '../src/ir/facts';

// deterministic fixture facts (mirror the harness fixtures — including the
// AAC priming lead-in that makes those audio tracks copy-ineligible [D1])
const FACTS: FactsTable = {
  a: {
    kind: 'video', duration: 8,
    video: { width: 320, height: 180, codec: 'avc', rotation: 0, firstTimestamp: 0 },
    audio: { sampleRate: 48000, channels: 2, codec: 'aac', firstTimestamp: -0.021333 },
  },
  b: {
    kind: 'video', duration: 5,
    video: { width: 480, height: 270, codec: 'avc', rotation: 0, firstTimestamp: 0 },
    audio: { sampleRate: 44100, channels: 1, codec: 'aac', firstTimestamp: -0.023219 },
  },
  music: { kind: 'audio', duration: 10, audio: { sampleRate: 44100, channels: 2, codec: 'pcm-s16', firstTimestamp: 0 } },
  logo: { kind: 'image', duration: Infinity, image: { width: 96, height: 48 } },
};

/** FACTS with clean (zero first-timestamp) audio — e.g. AAC muxed without an
 * edit list — for goldens exercising the audio copy path on video assets. */
const CLEAN_FACTS: FactsTable = {
  ...FACTS,
  a: {
    ...FACTS.a!,
    audio: { sampleRate: 48000, channels: 2, codec: 'aac', firstTimestamp: 0 },
  },
};

const doc = (render: Record<string, unknown>, assets?: Record<string, { kind: string }>) => ({
  version: '0.1',
  assets: assets ?? {
    a: { kind: 'video' }, b: { kind: 'video' }, music: { kind: 'audio' }, logo: { kind: 'image' },
  },
  operations: [{ id: 'out', op: 'render', ...render }],
});

const av = { container: 'mp4', video: {}, audio: {} };

describe('plan(): single-clip cases', () => {
  it('untouched mp4→mp4: video copies; AAC priming keeps audio on re-encode [D1]', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: av }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.canvas).toEqual({ w: 320, h: 180 });
    expect(p.spans).toHaveLength(1);
    expect(p.spans[0]).toMatchObject({ start: 0, end: 8 });
    expect(p.spans[0]!.video!.bindings[0]).toMatchObject({ slot: 0, asset: 'a', sourceStart: 0, sourceEnd: 8, offset: 0 });
    expect(p.spans[0]!.audio).toMatchObject({ mode: 'single' });
    expect(p.audioFormat).toEqual({ rate: 48000, channels: 2 });
    expect(p.strategy).toEqual({ video: 'copy', audio: 'reencode' });
    expect(p.copy).toEqual({ video: { asset: 'a', codec: 'avc', end: 8 } });
  });

  it('trim: range [2,5) → span [0,3), offset -2', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a', range: { start: 2, end: 5 } }], output: av }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[0]).toMatchObject({ start: 0, end: 3 });
    expect(r.plan!.spans[0]!.video!.bindings[0]).toMatchObject({ sourceStart: 2, sourceEnd: 5, offset: -2 });
  });

  it('symbolic trim: last 5 seconds', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a', range: { start: -5 } }], output: av }), FACTS);
    expect(r.plan!.spans[0]).toMatchObject({ start: 0, end: 5 });
    expect(r.plan!.spans[0]!.video!.bindings[0]).toMatchObject({ sourceStart: 3, sourceEnd: 8 });
  });

  it('crop (region form): srcRect + canvas from geometry inference', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'crop', regionSource: 'user', region: { width: '50%', height: '100%' } }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.canvas).toEqual({ w: 160, h: 180 });
    const layer = r.plan!.spans[0]!.video!.composite.layers[0]!;
    expect(layer.srcRect).toEqual({ x: 0, y: 0, w: 160, h: 180 });
    expect(layer.transform).toEqual([1, 0, 0, 0, 1, 0]);
  });

  it('crop (aspect form): centered 1:1 on 320x180 keeps middle 180px', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'crop', regionSource: 'user', aspect: '1:1' }] }],
      output: av,
    }), FACTS);
    expect(r.plan!.canvas).toEqual({ w: 180, h: 180 });
    expect(r.plan!.spans[0]!.video!.composite.layers[0]!.srcRect).toEqual({ x: 70, y: 0, w: 180, h: 180 });
  });

  it('fused crop+resize+flip matches the proven E2 matrix', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [
        { type: 'crop', regionSource: 'user', region: { width: 160, height: 180 } },
        { type: 'resize', width: 80, height: 90 },
        { type: 'flip', axis: 'horizontal' },
      ] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.canvas).toEqual({ w: 80, h: 90 });
    const layer = r.plan!.spans[0]!.video!.composite.layers[0]!;
    expect(layer.srcRect).toEqual({ x: 0, y: 0, w: 160, h: 180 });
    expect(layer.transform).toEqual([-0.5, 0, 80, 0, 0.5, 0]);
  });

  it('rotate 90: swapped canvas and permutation matrix', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'rotate', degrees: 90 }] }],
      output: av,
    }), FACTS);
    expect(r.plan!.canvas).toEqual({ w: 180, h: 320 });
    expect(r.plan!.spans[0]!.video!.composite.layers[0]!.transform).toEqual([0, -1, 180, 1, 0, 0]);
  });

  it('pad to 9:16: pillarboxed geometry drives the canvas', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'pad', aspect: '9:16' }] }],
      output: av,
    }), FACTS);
    // 320x180 padded to 9:16 → height grows: w=320, h=320*16/9≈568.9 → even 570?
    const c = r.plan!.canvas;
    expect(c.w).toBe(320);
    expect(Math.abs(c.h - (320 * 16) / 9)).toBeLessThan(2);
  });
});

describe('plan(): timeline structure', () => {
  it('concat: two spans, largest base wins the canvas [V1]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }, { type: 'clip', source: 'b' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.canvas).toEqual({ w: 480, h: 270 });
    expect(p.spans.map((s) => [s.start, s.end])).toEqual([[0, 8], [8, 13]]);
    expect(p.spans[1]!.video!.bindings[0]).toMatchObject({ asset: 'b', offset: 8 });
  });

  it('crossfade: three spans with consume semantics [X2] and both-lane ramps [X3]', () => {
    const r = plan(doc({
      timeline: [
        { type: 'clip', source: 'a' },
        { type: 'transition', style: 'crossfade', duration: 1 },
        { type: 'clip', source: 'b' },
      ],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.spans.map((s) => [s.start, s.end])).toEqual([[0, 7], [7, 8], [8, 12]]);
    const overlap = p.spans[1]!;
    expect(overlap.video!.bindings).toHaveLength(2);
    expect(overlap.video!.opacityRamps).toEqual({ 1: { from: 0, to: 1, over: [7, 8] } });
    expect(overlap.audio!.mode).toBe('mix');
    expect(overlap.audio!.gainRamps![0]).toEqual({ from: 1, to: 0, over: [7, 8] });
    expect(overlap.audio!.gainRamps![1]).toEqual({ from: 0, to: 1, over: [7, 8] });
    // incoming clip's source window during the overlap starts at its beginning
    expect(overlap.video!.bindings[1]).toMatchObject({ asset: 'b', sourceStart: 0, sourceEnd: 1, offset: 7 });
  });

  it('speed [T3]: 2x on an 8s clip → 4s output, scaled bindings on both lanes', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a', speed: 2 }], output: av }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.spans.map((s) => [s.start, s.end])).toEqual([[0, 4]]);
    expect(p.spans[0]!.video!.bindings[0]).toMatchObject({
      sourceStart: 0, sourceEnd: 8, offset: 0, rate: 2,
    });
    expect(p.spans[0]!.audio!.bindings[0]).toMatchObject({
      sourceStart: 0, sourceEnd: 8, offset: 0, rate: 2,
    });
    expect(p.strategy).toEqual({ video: 'reencode', audio: 'reencode' });
  });

  it('speed with trim: range [2,6) at 2x → 2s output, offset carries the scaled map', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', range: { start: 2, end: 6 }, speed: 2 }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const b = r.plan!.spans[0]!.video!.bindings[0]!;
    // t_out = t_src/2 + offset must map source 2 → output 0: offset = -1
    expect(b).toMatchObject({ sourceStart: 2, sourceEnd: 6, offset: -1, rate: 2 });
    expect(r.plan!.spans[0]).toMatchObject({ start: 0, end: 2 });
  });

  it('speed in a concat: sped clip shortens the timeline, neighbors unscaled', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', speed: 2 }, { type: 'clip', source: 'b' }],
      output: av,
    }), FACTS);
    expect(r.plan!.spans.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 9]]);
    expect(r.plan!.spans[1]!.video!.bindings[0]).toMatchObject({ asset: 'b', offset: 4 });
    expect(r.plan!.spans[1]!.video!.bindings[0]!.rate).toBeUndefined();
  });

  it('slowdown: speed 0.5 doubles the output duration', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a', speed: 0.5 }], output: av }), FACTS);
    expect(r.plan!.spans.map((s) => [s.start, s.end])).toEqual([[0, 16]]);
    expect(r.plan!.spans[0]!.video!.bindings[0]).toMatchObject({ sourceStart: 0, sourceEnd: 8, rate: 0.5 });
  });

  it('transition longer than a neighbor is an error [X2]', () => {
    const r = preflight(doc({
      timeline: [
        { type: 'clip', source: 'a', range: { end: 0.5 } },
        { type: 'transition', style: 'crossfade', duration: 1 },
        { type: 'clip', source: 'b' },
      ],
      output: av,
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'transition-too-long')).toBe(true);
  });
});

describe('plan(): compositions, overlays, audio model', () => {
  it("Sam's podcast case: slot-scoped music mixes and fades with the transition", () => {
    const r = plan(doc({
      timeline: [
        { type: 'composition', layers: [
          { type: 'video', source: 'a' },
          { type: 'audio', source: 'music', volume: '30%' },
        ] },
        { type: 'transition', style: 'crossfade', duration: 1 },
        { type: 'clip', source: 'b' },
      ],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.spans.map((s) => [s.start, s.end])).toEqual([[0, 7], [7, 8], [8, 12]]);
    // span 1: voice + music mixing, music at 0.3 constant
    const s0 = p.spans[0]!.audio!;
    expect(s0.mode).toBe('mix');
    expect(s0.bindings).toHaveLength(2);
    expect(s0.gainRamps![1]).toMatchObject({ from: 0.3, to: 0.3 });
    // overlap: both slot contributors fade out, incoming fades in
    const ov = p.spans[1]!.audio!;
    expect(ov.bindings).toHaveLength(3);
    expect(ov.gainRamps![0]).toEqual({ from: 1, to: 0, over: [7, 8] });   // voice
    expect(ov.gainRamps![1]).toEqual({ from: 0.3, to: 0, over: [7, 8] }); // music
    expect(ov.gainRamps![2]).toEqual({ from: 0, to: 1, over: [7, 8] });   // incoming
  });

  it('image overlay + windowed music: spans split at the window edge, staticSlots carried', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [
        { type: 'image', source: 'logo', place: { anchor: 'bottom-right', margin: 8, width: '25%' }, placementSource: 'user', opacity: 0.85 },
        { type: 'audio', source: 'music', from: 0, duration: 4, volume: 0.3 },
      ],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.spans.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 8]]);
    for (const span of p.spans) {
      expect(span.video!.staticSlots).toEqual({ 1: 'logo' });
      const logoLayer = span.video!.composite.layers[1]!;
      expect(logoLayer.input).toBe(1);
      expect(logoLayer.opacity).toBe(0.85);
      // 25% of 320 = 80 wide, anchored bottom-right with margin 8 → x = 320-80-8
      expect(logoLayer.transform[2]).toBeCloseTo(232);
    }
    expect(p.spans[0]!.audio!.mode).toBe('mix');
    expect(p.spans[1]!.audio!.mode).toBe('single');
  });

  it('side-by-side halves via composition + place [G4]', () => {
    const r = plan(doc({
      timeline: [{ type: 'composition', layers: [
        { type: 'video', source: 'a',
          effects: [{ type: 'crop', regionSource: 'user', region: { width: '50%', height: '100%' } }],
          place: { anchor: 'left', width: '50%', height: '100%' } },
        { type: 'video', source: 'a',
          effects: [{ type: 'crop', regionSource: 'user', region: { x: '50%', width: '50%', height: '100%' } }],
          place: { anchor: 'right', width: '50%', height: '100%' } },
      ] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const layers = r.plan!.spans[0]!.video!.composite.layers;
    expect(layers).toHaveLength(2);
    expect(layers[0]!.srcRect).toEqual({ x: 0, y: 0, w: 160, h: 180 });
    expect(layers[1]!.srcRect).toEqual({ x: 160, y: 0, w: 160, h: 180 });
    // same asset, two slots — bindings for both
    expect(r.plan!.spans[0]!.video!.bindings).toHaveLength(2);
  });

  it('swap audio [D2]: wired source replaces timeline audio; truncated to output [D3]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: { from: 'music' } },
    }), FACTS);
    expect(r.errors).toEqual([]);
    const audio = r.plan!.spans[0]!.audio!;
    expect(audio.bindings).toHaveLength(1);
    expect(audio.bindings[0]).toMatchObject({ asset: 'music', sourceStart: 0, sourceEnd: 8 });
    expect(r.plan!.audioFormat!.rate).toBe(44100);
  });

  it('[D2 amendment] omitting BOTH tracks delivers what is there (never zero spans)', () => {
    // `output: {container: 'mp4'}` — the natural authoring shape — used to
    // lower to ZERO spans (both tracks "dropped") with no error.
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4' },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans.length).toBeGreaterThan(0);
    expect(r.plan!.spans[0]!.video).toBeDefined();
    expect(r.plan!.spans[0]!.audio).toBeDefined();

    const mp3 = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp3' },
    }), FACTS);
    expect(mp3.errors).toEqual([]);
    expect(mp3.plan!.spans.length).toBeGreaterThan(0);
    expect(mp3.plan!.spans[0]!.video).toBeUndefined();
  });

  it('mute [D2]: omitting output.audio yields no audio lane', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {} },
    }), FACTS);
    expect(r.plan!.spans[0]!.audio).toBeUndefined();
    expect(r.plan!.strategy.audio).toBe('none');
  });

  it('audio-only timeline [D4]', () => {
    const r = plan(doc({
      timeline: [
        { type: 'clip', source: 'music', range: { end: 4 } },
        { type: 'clip', source: 'music', range: { start: 4 } },
      ],
      output: { container: 'wav', audio: {} },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans).toHaveLength(2);
    expect(r.plan!.spans[0]!.video).toBeUndefined();
    expect(r.plan!.spans.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 10]]);
  });

  it('video output without video content is an error [D4]', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'music' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'video-output-without-video')).toBe(true);
  });

  it('top-level effects apply to the composed output [E1]: resize', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'resize', height: 90 }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.canvas).toEqual({ w: 160, h: 90 });
    // layer fills composed 320x180 then output chain scales by 0.5
    expect(r.plan!.spans[0]!.video!.composite.layers[0]!.transform).toEqual([0.5, 0, 0, 0, 0.5, 0]);
  });

  it('top-level effects apply to the composed output [E1]: crop across a concat', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }, { type: 'clip', source: 'b' }],
      effects: [{ type: 'crop', regionSource: 'user', aspect: '1:1' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    // composed canvas 480x270 → centered 1:1 crop → 270x270
    expect(r.plan!.canvas).toEqual({ w: 270, h: 270 });
    // both spans' layers shifted left by the crop origin (105)
    expect(r.plan!.spans[0]!.video!.composite.layers[0]!.transform[2]).toBeCloseTo(-105);
    expect(r.plan!.spans[1]!.video!.composite.layers[0]!.transform[2]).toBeCloseTo(-105);
  });

  it('composition-level effects with multiple visual layers are an honest error', () => {
    const r = preflight(doc({
      timeline: [{ type: 'composition',
        effects: [{ type: 'resize', height: 90 }],
        layers: [
          { type: 'video', source: 'a' },
          { type: 'image', source: 'logo', place: { anchor: 'center', width: '25%' } },
        ] }],
      output: av,
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'unsupported-in-v01')).toBe(true);
  });

  it('layer `at`: staggered entrance splits spans [A5]', () => {
    const r = plan(doc({
      timeline: [{ type: 'composition', layers: [
        { type: 'video', source: 'a' },
        { type: 'image', source: 'logo', at: 2, place: { anchor: 'bottom', margin: 8, width: '30%' } },
      ] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans.map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 8]]);
    expect(r.plan!.spans[0]!.video!.composite.layers).toHaveLength(1);
    expect(r.plan!.spans[1]!.video!.composite.layers).toHaveLength(2);
  });
});

describe('plan(): soft subtitles [D8]', () => {
  const SUB_FACTS: FactsTable = { ...FACTS, subs: { kind: 'timed-text', duration: 0 } };
  const subAssets = {
    a: { kind: 'video' }, b: { kind: 'video' }, music: { kind: 'audio' },
    logo: { kind: 'image' }, subs: { kind: 'timed-text' },
  };

  it('wires a timed-text asset into the output declaration', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mkv', video: {}, audio: {}, subtitles: { from: 'subs', language: 'eng' } },
    }, subAssets), SUB_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.output.subtitles).toEqual({ asset: 'subs', language: 'eng' });
  });

  it('subtitles on an audio-only container are field-not-applicable', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'music' }],
      output: { container: 'wav', audio: {}, subtitles: { from: 'subs' } },
    }, subAssets), SUB_FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'field-not-applicable')).toBe(true);
  });

  it('subtitles.from must reference a timed-text asset (no track extraction)', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: {}, subtitles: { from: 'b' } },
    }, subAssets), SUB_FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'usage-unavailable')).toBe(true);
  });

  it('a timed-text asset on the timeline is usage-unavailable', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'subs' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, subAssets), SUB_FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'usage-unavailable')).toBe(true);
  });

  it('subtitle wiring does not disturb stream-copy negotiation', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mkv', video: {}, audio: {}, subtitles: { from: 'subs' } },
    }, subAssets), SUB_FACTS);
    expect(r.plan!.strategy.video).toBe('copy');
  });
});

describe('plan(): lighting filters [E5]', () => {
  it('brightness lowers to a scaled identity matrix', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'brightness', amount: 1.5 }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const layer = r.plan!.spans[0]!.video!.composite.layers[0]!;
    expect(layer.color).toEqual({ matrix: [1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5], offset: [0, 0, 0] });
    // color is not geometry: the transform stays identity
    expect(layer.transform).toEqual([1, 0, 0, 0, 1, 0]);
    expect(r.plan!.strategy.video).toBe('reencode');
  });

  it('contrast pivots around mid-gray via the offset', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'contrast', amount: 2 }] }],
      output: av,
    }), FACTS);
    const c = r.plan!.spans[0]!.video!.composite.layers[0]!.color!;
    expect(c.matrix[0]).toBe(2);
    expect(c.offset).toEqual([-0.5, -0.5, -0.5]);
  });

  it('saturation 0 is the Rec.709 grayscale matrix (rows sum to 1)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'saturation', amount: 0 }] }],
      output: av,
    }), FACTS);
    const m = r.plan!.spans[0]!.video!.composite.layers[0]!.color!.matrix;
    for (const row of [0, 1, 2]) {
      expect(m[row * 3]! + m[row * 3 + 1]! + m[row * 3 + 2]!).toBeCloseTo(1, 5);
      expect(m[row * 3]).toBeCloseTo(0.2126, 4);
    }
  });

  it('lighting fuses with geometry effects in one layer (order-independent by math)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [
        { type: 'brightness', amount: 2 },
        { type: 'crop', regionSource: 'user', aspect: '1:1' },
        { type: 'brightness', amount: 0.5 },
      ] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const layer = r.plan!.spans[0]!.video!.composite.layers[0]!;
    // 2 × 0.5 = identity brightness; crop still applied
    expect(layer.color!.matrix[0]).toBeCloseTo(1, 5);
    expect(layer.srcRect).toEqual({ x: 70, y: 0, w: 180, h: 180 });
  });

  it('top-level lighting composes over every span layer across a concat', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }, { type: 'clip', source: 'b' }],
      effects: [{ type: 'saturation', amount: 0 }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    for (const span of r.plan!.spans) {
      expect(span.video!.composite.layers[0]!.color).toBeDefined();
    }
    // pure color effects leave the canvas untouched
    expect(r.plan!.canvas).toEqual({ w: 480, h: 270 });
  });

  it('lighting breaks video stream copy [D1]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'brightness', amount: 1.2 }] }],
      output: av,
    }), FACTS);
    expect(r.plan!.strategy.video).toBe('reencode');
  });
});

describe('plan(): frame extraction [D7]', () => {
  it('png at a symbolic time resolves on the output clock', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', range: { start: 2 } }],  // 6s output
      output: { container: 'png', video: {}, at: '50%' },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.still).toEqual({ time: 3 });
    expect(r.plan!.strategy.audio).toBe('none');
    expect(r.plan!.canvas).toEqual({ w: 320, h: 180 });
  });

  it("'end' clamps to the last frame; jpeg quality maps from output.video.quality", () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'jpeg', video: { quality: 'medium' }, at: 'end' },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.still).toEqual({ time: 7.999, quality: 0.85 });
  });

  it('out-of-range frame time is a window-invalid error', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', video: {}, at: 30 },
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'window-invalid')).toBe(true);
  });

  it('audio on an image output is field-not-applicable', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', video: {}, audio: {} },
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'field-not-applicable')).toBe(true);
  });

  it("'at' on a video container is field-not-applicable", () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: {}, at: 3 },
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'field-not-applicable')).toBe(true);
  });
});

describe('plan(): burn-in captions [O5]', () => {
  const SUB_FACTS: FactsTable = { ...FACTS, subs: { kind: 'timed-text', duration: 0 } };
  const subAssets = {
    a: { kind: 'video' }, b: { kind: 'video' }, music: { kind: 'audio' },
    logo: { kind: 'image' }, subs: { kind: 'timed-text' },
  };

  it('captions overlay lowers to a captionSlot with a full-canvas identity layer', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'subs' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, subAssets), SUB_FACTS);
    expect(r.errors).toEqual([]);
    const lane = r.plan!.spans[0]!.video!;
    // slot 1 is the caption; it has NO binding and NO static
    expect(lane.bindings).toHaveLength(1);
    expect(lane.captionSlots).toEqual({
      1: {
        asset: 'subs', style: 'shadow', color: '#ffffff', font: 'Helvetica',
        sizePx: 13,  // 7% of 180
        box: { x: 32, y: 108, w: 256, h: 63 },  // 80%x35%, bottom, 5% margin
      },
    });
    const layer = lane.composite.layers[1]!;
    expect(layer.input).toBe(1);
    expect(layer.transform).toEqual([1, 0, 0, 0, 1, 0]);
    expect(layer.srcRect).toEqual({ x: 0, y: 0, w: 320, h: 180 });
  });

  it('styling and placement options resolve against the canvas', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'subs', style: 'outline', color: '#ff0000', size: 20, place: { anchor: 'top', width: '50%' } }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, subAssets), SUB_FACTS);
    expect(r.errors).toEqual([]);
    const spec = r.plan!.spans[0]!.video!.captionSlots![1]!;
    expect(spec).toMatchObject({ style: 'outline', color: '#ff0000', sizePx: 20 });
    expect(spec.box.w).toBe(160);
    expect(spec.box.y).toBeCloseTo(9);  // top anchor + 5% margin
  });

  it('captions break video stream copy (a second contributor)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'subs' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, subAssets), SUB_FACTS);
    expect(r.plan!.strategy.video).toBe('reencode');
  });

  it('captions from a non-timed-text source are usage-unavailable', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'b' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, subAssets), SUB_FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'usage-unavailable')).toBe(true);
  });

  it('windowed captions split spans like other overlays', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'subs', from: 2, to: 6 }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, subAssets), SUB_FACTS);
    expect(r.plan!.spans.map((s) => [s.start, s.end])).toEqual([[0, 2], [2, 6], [6, 8]]);
    expect(r.plan!.spans[1]!.video!.captionSlots).toBeDefined();
    expect(r.plan!.spans[0]!.video!.captionSlots).toBeUndefined();
  });
});

describe('plan(): gif output [D9]', () => {
  it('gif is a video-only rendered delivery: no audio lane, never copy', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', range: { end: 2 } }],
      output: { container: 'gif', video: {} },
    }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.strategy).toEqual({ video: 'reencode', audio: 'none' });
    expect(p.audioFormat).toBeUndefined();
    expect(p.spans[0]!.audio).toBeUndefined();
    expect(p.spans.map((s) => [s.start, s.end])).toEqual([[0, 2]]);
  });

  it('pixel-only outputs imply video: {} — gif/png without a video field plan fine', () => {
    for (const container of ['gif', 'png'] as const) {
      const r = plan(doc({
        timeline: [{ type: 'clip', source: 'a', range: { end: 2 } }],
        output: { container },
      }), FACTS);
      expect(r.errors).toEqual([]);
      expect(r.plan).not.toBeNull();
    }
  });

  it('gif with audio is field-not-applicable', () => {
    const r = preflight(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'gif', video: {}, audio: {} },
    }), FACTS);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'field-not-applicable')).toBe(true);
  });
});

describe('plan(): stream-copy negotiation [D1]', () => {
  it('remux mp4→mkv untouched: both tracks copy (clean audio timestamps)', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: { container: 'mkv', video: {}, audio: {} } }), CLEAN_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.strategy).toEqual({ video: 'copy', audio: 'copy' });
    expect(r.plan!.copy).toEqual({
      video: { asset: 'a', codec: 'avc', end: 8 },
      audio: { asset: 'a', codec: 'aac', end: 8 },
    });
  });

  it('AAC priming (negative first timestamp) makes audio copy-ineligible', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: { container: 'mkv', video: {}, audio: {} } }), FACTS);
    expect(r.plan!.strategy).toEqual({ video: 'copy', audio: 'reencode' });
    expect(r.plan!.copy).toEqual({ video: { asset: 'a', codec: 'avc', end: 8 } });
  });

  it('avc into webm is codec-illegal: re-encode', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: { container: 'webm', video: {}, audio: {} } }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.strategy).toEqual({ video: 'reencode', audio: 'reencode' });
    expect(r.plan!.copy).toBeUndefined();
  });

  it('a video effect breaks video copy but audio still copies (per-track)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'crop', regionSource: 'user', aspect: '1:1' }] }],
      output: av,
    }), CLEAN_FACTS);
    expect(r.plan!.strategy).toEqual({ video: 'reencode', audio: 'copy' });
    expect(r.plan!.copy).toEqual({ audio: { asset: 'a', codec: 'aac', end: 8 } });
  });

  it('volume breaks audio copy but video still copies (per-track)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', volume: 0.5 }],
      output: av,
    }), FACTS);
    expect(r.plan!.strategy).toEqual({ video: 'copy', audio: 'reencode' });
    expect(r.plan!.copy).toEqual({ video: { asset: 'a', codec: 'avc', end: 8 } });
  });

  it('trim breaks copy on both tracks (keyframe boundaries)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', range: { start: 2 } }],
      output: av,
    }), FACTS);
    expect(r.plan!.strategy).toEqual({ video: 'reencode', audio: 'reencode' });
  });

  it('pinned codec, quality, or bitrate forces re-encode even when untouched', () => {
    const pinned = plan(doc({ timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: { codec: 'avc' }, audio: {} } }), FACTS);
    expect(pinned.plan!.strategy.video).toBe('reencode');
    const quality = plan(doc({ timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: { quality: 'high' }, audio: {} } }), FACTS);
    expect(quality.plan!.strategy.video).toBe('reencode');
    const bitrate = plan(doc({ timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: { bitrate: 96000 } } }), FACTS);
    expect(bitrate.plan!.strategy.audio).toBe('reencode');
  });

  it('concat/transition/overlay all break copy (multiple contributors)', () => {
    const concat = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }, { type: 'clip', source: 'b' }], output: av,
    }), FACTS);
    expect(concat.plan!.strategy).toEqual({ video: 'reencode', audio: 'reencode' });
    const overlay = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'image', source: 'logo', place: { anchor: 'center', width: '25%' }, placementSource: 'user' }],
      output: av,
    }), CLEAN_FACTS);
    expect(overlay.plan!.strategy.video).toBe('reencode');
    expect(overlay.plan!.strategy.audio).toBe('copy');
  });

  it('swap-audio with a PCM source into mp4 stays re-encode (playback-safe subset)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: { from: 'music' } },
    }), FACTS);
    expect(r.plan!.strategy).toEqual({ video: 'copy', audio: 'reencode' });
  });

  it('audio-only remux: pcm into wav copies, truncation carries activeTo', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'music', range: { end: 10 } }],
      output: { container: 'wav', audio: {} },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.strategy.audio).toBe('copy');
    expect(r.plan!.copy).toEqual({ audio: { asset: 'music', codec: 'pcm-s16', end: 10 } });
  });

  it('resample [D6]: explicit sampleRate lands in audioFormat and breaks copy', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'music' }],
      output: { container: 'wav', audio: { sampleRate: 22050 } },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.audioFormat).toEqual({ rate: 22050, channels: 2 });
    expect(r.plan!.strategy.audio).toBe('reencode');
  });

  it('resample [D6]: sampleRate equal to the source is a no-op and keeps copy', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'music' }],
      output: { container: 'wav', audio: { sampleRate: 44100 } },
    }), FACTS);
    expect(r.plan!.audioFormat!.rate).toBe(44100);
    expect(r.plan!.strategy.audio).toBe('copy');
  });

  it('missing codec facts conservatively re-encode', () => {
    const bare: FactsTable = {
      a: { kind: 'video', duration: 8, video: { width: 320, height: 180 }, audio: { sampleRate: 48000, channels: 2 } },
    };
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: av }), bare);
    expect(r.plan!.strategy).toEqual({ video: 'reencode', audio: 'reencode' });
  });

  it('top-level output effects break video copy', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'resize', height: 90 }],
      output: av,
    }), FACTS);
    expect(r.plan!.strategy.video).toBe('reencode');
  });
});


describe('plan(): tier-1 pipelines [G1] — derivers + model kernels', () => {
  const SUBS_FACTS: FactsTable = { ...FACTS, subs: { kind: 'timed-text', duration: 0 } };
  const pipe = (operations: unknown[], assets?: Record<string, { kind: string }>) => ({
    version: '0.1',
    assets: assets ?? { a: { kind: 'video' }, logo: { kind: 'image' }, subs: { kind: 'timed-text' } },
    operations,
  });

  it('transcribe-only pipeline: no plan, artifact is the deliverable [G2]', () => {
    const r = plan(pipe([{ id: 'caps', op: 'transcribe', source: 'a' }]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan).toBeNull();
    expect(r.pipeline).toEqual({
      steps: [{ kind: 'transcribe', id: 'caps', source: 'a', params: { model: 'base' }, format: 'vtt' }],
      deliver: 'caps',
      deliverables: ['caps'],
    });
  });

  it('every sink op delivers [G2 amendment]: three frame extracts → three deliverables', () => {
    const extract = (id: string, at: unknown) => ({
      id, op: 'render',
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', at, name: `frame-${id}` },
    });
    const r = plan(pipe([extract('f1', 0), extract('f2', '50%'), extract('f3', 'end')]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.deliverables).toEqual(['f1', 'f2', 'f3']);
    expect(r.pipeline!.deliver).toBe('f3');
    expect(r.plan!.still).toBeDefined(); // back-compat surface = last render
  });

  it('consumed ops are NOT deliverables: transcribe → burn has one sink', () => {
    const r = plan(pipe([
      { id: 'caps', op: 'transcribe', source: 'a' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'captions', source: 'caps' }],
        output: av,
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.deliverables).toEqual(['out']);
  });

  it('transcribe params: model, language, srt format', () => {
    const r = plan(pipe([{ id: 'caps', op: 'transcribe', source: 'a', model: 'small', language: 'es', format: 'srt' }]), SUBS_FACTS);
    expect(r.pipeline!.steps[0]).toMatchObject({ params: { model: 'small', language: 'es' }, format: 'srt' });
  });

  it('transcribe → burn: the render resolves the artifact reference [R2]', () => {
    const r = plan(pipe([
      { id: 'caps', op: 'transcribe', source: 'a' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'captions', source: 'caps' }],
        output: av,
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps.map((s) => s.id)).toEqual(['caps', 'out']);
    expect(r.pipeline!.deliver).toBe('out');
    const lane = r.plan!.spans[0]!.video!;
    expect(Object.values(lane.captionSlots!)[0]!.asset).toBe('caps');
  });

  it('transcribe → translate → soft subs: the full deriver chain', () => {
    const r = plan(pipe([
      { id: 'caps', op: 'transcribe', source: 'a' },
      { id: 'caps_es', op: 'translate', source: 'caps', to: 'es' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        output: { ...av, subtitles: { from: 'caps_es', language: 'spa' } },
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps.map((s) => s.id)).toEqual(['caps', 'caps_es', 'out']);
    expect(r.pipeline!.steps[1]).toMatchObject({ kind: 'translate', source: 'caps', params: { to: 'es' } });
    expect(r.plan!.output.subtitles).toEqual({ asset: 'caps_es', language: 'spa' });
  });

  it('removebg: image artifact usable as an overlay source [B3]', () => {
    const r = plan(pipe([
      { id: 'cut', op: 'removebg', source: 'logo' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'image', source: 'cut', place: { anchor: 'bottom-right', width: '20%' }, placementSource: 'user' }],
        output: av,
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps[0]).toMatchObject({ kind: 'removebg', format: 'png' });
    const lane = r.plan!.spans[0]!.video!;
    expect(Object.values(lane.staticSlots!)).toContain('cut');
  });

  it('removebg: the optional model tier reaches the step params; omitted = host default', () => {
    const fast = plan(pipe([{ id: 'cut', op: 'removebg', source: 'logo', model: 'fast' }]), SUBS_FACTS);
    expect(fast.errors).toEqual([]);
    expect(fast.pipeline!.steps[0]).toMatchObject({ kind: 'removebg', params: { model: 'fast' } });
    const dflt = plan(pipe([{ id: 'cut', op: 'removebg', source: 'logo' }]), SUBS_FACTS);
    expect(dflt.pipeline!.steps[0]).toMatchObject({ kind: 'removebg', params: {} });
    const bad = plan(pipe([{ id: 'cut', op: 'removebg', source: 'logo', model: 'birefnet' } as never]), SUBS_FACTS);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('transformImage: filtered image artifact usable as an overlay source', () => {
    const r = plan(pipe([
      { id: 'gray', op: 'transformImage', source: 'logo', effects: [{ type: 'grayscale' }] },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'image', source: 'gray', place: { anchor: 'bottom-right', width: '20%' }, placementSource: 'user' }],
        output: av,
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    const step = r.pipeline!.steps[0]!;
    if (step.kind !== 'transformImage') throw new Error(`step 0 is ${step.kind}`);
    expect(step).toMatchObject({ source: 'logo', format: 'png' });
    // the inner plan is a still render of the logo with the affine fused
    expect(step.plan.canvas).toEqual({ w: 96, h: 48 });
    expect(step.plan.output.container).toBe('png');
    const inner = step.plan.spans[0]!.video!;
    expect(inner.staticSlots).toEqual({ 0: 'logo' });
    expect(inner.composite.layers[0]!.color).toBeDefined();
    // downstream render sees the artifact like any image asset
    expect(Object.values(r.plan!.spans[0]!.video!.staticSlots!)).toContain('gray');
  });

  it('transformImage: intermediates encode png even when jpeg is authored (alpha survives)', () => {
    const r = plan(pipe([
      { id: 'gray', op: 'transformImage', source: 'logo', effects: [{ type: 'grayscale' }], format: 'jpeg' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'image', source: 'gray', place: { anchor: 'top-right', width: '20%' }, placementSource: 'assumed' }],
        output: av,
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    const step = r.pipeline!.steps[0]!;
    if (step.kind !== 'transformImage') throw new Error(`step 0 is ${step.kind}`);
    expect(step.plan.output.container).toBe('png');
  });

  it('transformImage terminal: the still plan delivers, geometry effects change artifact dims', () => {
    const r = plan(pipe([
      { id: 'small', op: 'transformImage', source: 'logo', effects: [{ type: 'resize', width: 48 }], format: 'jpeg', name: 'logo-small' },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan).toBeNull(); // deriver-terminal surface, like removebg [G2]
    const step = r.pipeline!.steps[0]!;
    if (step.kind !== 'transformImage') throw new Error(`step 0 is ${step.kind}`);
    expect(step.plan.output.container).toBe('jpeg');
    expect(step.plan.canvas).toEqual({ w: 48, h: 24 });
  });

  it('removebg → transformImage chain: artifacts feed artifacts', () => {
    const r = plan(pipe([
      { id: 'cut', op: 'removebg', source: 'logo' },
      { id: 'graycut', op: 'transformImage', source: 'cut', effects: [{ type: 'grayscale' }] },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'image', source: 'graycut', place: { anchor: 'bottom-left', width: '15%' }, placementSource: 'user' }],
        output: av,
      },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps.map((s) => s.kind)).toEqual(['removebg', 'transformImage', 'render']);
  });

  it('transformImage refuses kernels honestly, with authored-shape paths', () => {
    const r = plan(pipe([
      { id: 'up', op: 'transformImage', source: 'logo', effects: [{ type: 'upscale' }] },
    ]), SUBS_FACTS);
    expect(r.errors.map((e) => [e.code, e.path])).toEqual([['usage-unavailable', 'operations[0].effects']]);
  });

  it('kind mismatches are usage-unavailable', () => {
    const bad = (ops: unknown[]) => plan(pipe(ops), SUBS_FACTS).errors.map((e) => e.code);
    expect(bad([{ id: 't', op: 'translate', source: 'a', to: 'es' }])).toContain('usage-unavailable');
    expect(bad([{ id: 'b', op: 'removebg', source: 'a' }])).toContain('usage-unavailable');
    expect(bad([{ id: 'ti', op: 'transformImage', source: 'a', effects: [{ type: 'grayscale' }] }])).toContain('usage-unavailable');
    expect(bad([{ id: 'c', op: 'transcribe', source: 'logo' }])).toContain('usage-unavailable');
    expect(bad([{ id: 'c', op: 'transcribe', source: 'subs' }])).toContain('usage-unavailable');
  });

  it('reference cycles are structural errors [G1]', () => {
    const r = plan(pipe([
      { id: 't1', op: 'translate', source: 't2', to: 'es' },
      { id: 't2', op: 'translate', source: 't1', to: 'fr' },
    ]), SUBS_FACTS);
    expect(r.errors.some((e) => e.code === 'reference-cycle')).toBe(true);
  });

  it('forward references are legal — topological order differs from authored', () => {
    const r = plan(pipe([
      { id: 'caps_es', op: 'translate', source: 'caps', to: 'es' },
      { id: 'caps', op: 'transcribe', source: 'a' },
    ]), SUBS_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps.map((s) => s.id)).toEqual(['caps', 'caps_es']);
    expect(r.pipeline!.deliver).toBe('caps');   // last AUTHORED [G2]
  });

  it('upscale [U1/U2]: composite at source canvas, kernel to 2x, copy broken', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'upscale' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.compositeCanvas).toEqual({ w: 320, h: 180 });
    expect(p.canvas).toEqual({ w: 640, h: 360 });
    expect(p.videoKernels).toEqual([{ op: 'upscale', params: { model: 'auto', from: { w: 320, h: 180 }, to: { w: 640, h: 360 } } }]);
    expect(p.strategy.video).toBe('reencode');
    // composite spec still targets the composite canvas
    expect(p.spans[0]!.video!.composite.canvas).toEqual({ w: 320, h: 180 });
  });

  it('upscale to an explicit resolution: the kernel targets it [U2]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'upscale', scale: 4, model: 'ultra' }],
      output: { ...av, resolution: { width: 1280, height: 720 } },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.compositeCanvas).toEqual({ w: 320, h: 180 });
    expect(r.plan!.canvas).toEqual({ w: 1280, h: 720 });
    expect(r.plan!.videoKernels![0]!.params).toMatchObject({ model: 'ultra', to: { w: 1280, h: 720 } });
  });

  it('upscale composes after top-level geometry effects', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'crop', regionSource: 'user', aspect: '1:1' }, { type: 'upscale' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.compositeCanvas).toEqual({ w: 180, h: 180 });
    expect(r.plan!.canvas).toEqual({ w: 360, h: 360 });
  });

  it('denoise [H1]: audio kernel, copy broken, 48 kHz default', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'denoise', model: 'high' }],
      output: av,
    }), CLEAN_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.audioKernels).toEqual([{ op: 'denoise', params: { model: 'high' } }]);
    expect(r.plan!.strategy.audio).toBe('reencode');
    expect(r.plan!.audioFormat).toEqual({ rate: 48000, channels: 2 });
    // video lane untouched by an audio kernel — still copies
    expect(r.plan!.strategy.video).toBe('copy');
  });

  it('denoise without an audio track is usage-unavailable', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'denoise' }],
      output: { container: 'mp4', video: {} },
    }), FACTS);
    expect(r.errors.some((e) => e.code === 'usage-unavailable')).toBe(true);
  });

  it('model kernels off the top level are rejected [U1/H1]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'upscale' }] }],
      output: av,
    }), FACTS);
    expect(r.errors.some((e) => e.code === 'unsupported-in-v01')).toBe(true);
  });
});

describe('plan(): image as timeline base [D7a] (photo in → photo out)', () => {
  const PHOTO_FACTS: FactsTable = {
    ...FACTS,
    photo: { kind: 'image', duration: Infinity, image: { width: 801, height: 601 } },
  };
  const assets = { photo: { kind: 'image' }, logo: { kind: 'image' }, a: { kind: 'video' } };

  it('photo → png: still plan, static base slot, EXACT (odd) dims — no even-rounding', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      output: { container: 'png' },
    }, assets), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.canvas).toEqual({ w: 801, h: 601 });
    expect(p.still).toEqual({ time: 0 });
    expect(p.spans).toHaveLength(1);
    const lane = p.spans[0]!.video!;
    expect(lane.bindings).toEqual([]);
    expect(lane.staticSlots).toEqual({ 0: 'photo' });
    expect(p.strategy).toEqual({ video: 'reencode', audio: 'none' });
  });

  it('photo + square crop → 601x601 jpeg with quality', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo', effects: [{ type: 'crop', aspect: '1:1', regionSource: 'user' }] }],
      output: { container: 'jpeg', video: { quality: 'high' } },
    }, assets), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.canvas).toEqual({ w: 601, h: 601 });
    expect(r.plan!.still).toEqual({ time: 0, quality: 0.95 });
    expect(r.plan!.spans[0]!.video!.composite.layers[0]!.srcRect).toEqual({ x: 100, y: 0, w: 601, h: 601 });
  });

  it('photo + logo overlay → two static slots, no bindings', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      overlays: [{ type: 'image', source: 'logo', place: { anchor: 'bottom-right', width: '20%' }, placementSource: 'user' }],
      output: { container: 'png' },
    }, assets), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    const lane = r.plan!.spans[0]!.video!;
    expect(lane.bindings).toEqual([]);
    expect(lane.staticSlots).toEqual({ 0: 'photo', 1: 'logo' });
  });

  it('photo → mp4 with no audio and no duration is an honest error [D7b]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      output: { container: 'mp4', video: {} },
    }, assets), PHOTO_FACTS);
    expect(r.plan).toBeNull();
    expect(r.errors.some((e) => e.code === 'usage-unavailable' && /needs a duration/.test(e.message))).toBe(true);
  });

  const AV_ASSETS = { photo: { kind: 'image' }, music: { kind: 'audio' }, a: { kind: 'video' }, logo: { kind: 'image' } };

  it('photo + output.audio.from → ticker video, duration = the soundtrack [D7b]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      output: { container: 'mp4', video: {}, audio: { from: 'music' } },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.still).toBeUndefined();
    expect(p.spans[p.spans.length - 1]!.end).toBe(10); // music duration
    const lane = p.spans[0]!.video!;
    expect(lane.bindings).toEqual([]);
    expect(lane.staticSlots).toEqual({ 0: 'photo' });
    expect(lane.tick).toBe(30);
    expect(p.spans[0]!.audio!.bindings[0]!.asset).toBe('music');
    expect(p.strategy.video).toBe('reencode');
    expect(p.canvas).toEqual({ w: 802, h: 602 }); // video encode rounds even
  });

  it('photo + audio overlay also derives the duration', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      overlays: [{ type: 'audio', source: 'music' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[r.plan!.spans.length - 1]!.end).toBe(10);
    expect(r.plan!.spans[0]!.video!.tick).toBe(30);
  });

  it('composition.duration makes a silent slide; output.fps names the tick rate', () => {
    const r = plan(doc({
      timeline: [{ type: 'composition', layers: [{ type: 'image', source: 'photo' }], duration: 5 }],
      output: { container: 'mp4', video: {}, fps: 12 },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[r.plan!.spans.length - 1]!.end).toBe(5);
    expect(r.plan!.spans[0]!.video!.tick).toBe(12);
  });

  it('gif from a photo with an explicit duration', () => {
    const r = plan(doc({
      timeline: [{ type: 'composition', layers: [{ type: 'image', source: 'photo' }], duration: 2 }],
      output: { container: 'gif' },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[r.plan!.spans.length - 1]!.end).toBe(2);
    expect(r.plan!.spans[0]!.video!.tick).toBe(30);
  });

  it('output.fps on a DECODED video timeline conforms via plan.fps [D5]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: {}, fps: 24 },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.fps).toBe(24);
    expect(r.plan!.strategy.video).toBe('reencode');
  });

  it('video overlays over a still base are rejected honestly (no frame clock)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      overlays: [{ type: 'video', source: 'a', place: { anchor: 'bottom-right', width: '30%' }, placementSource: 'user' }],
      output: { container: 'mp4', video: {}, audio: { from: 'music' } },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors.some((e) => e.code === 'unsupported-in-v01' && /video overlays over a still/.test(e.message))).toBe(true);
  });

  it('image overlays and captions ride the ticker fine', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo' }],
      overlays: [{ type: 'image', source: 'logo', place: { anchor: 'top-right', width: '20%' }, placementSource: 'assumed' }],
      output: { container: 'mp4', video: {}, audio: { from: 'music' } },
    }, AV_ASSETS), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    const lane = r.plan!.spans[0]!.video!;
    expect(lane.bindings).toEqual([]);
    expect(lane.staticSlots).toEqual({ 0: 'photo', 1: 'logo' });
    expect(lane.tick).toBe(30);
  });

  it('range on an image base is field-not-applicable', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo', range: { start: 1 } }],
      output: { container: 'png' },
    }, assets), PHOTO_FACTS);
    expect(r.errors.some((e) => e.code === 'field-not-applicable')).toBe(true);
  });

  it('video timelines with png output still bind and decode (unchanged)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', at: 4 },
    }, assets), PHOTO_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.still).toEqual({ time: 4 });
    expect(r.plan!.spans[0]!.video!.bindings).toHaveLength(1);
  });
});

describe('plan(): filter effects [E6] — affine fusion vs pass steps', () => {
  const layer0 = (r: ReturnType<typeof plan>) => r.plan!.spans[0]!.video!.composite.layers[0]!;

  it('all-affine chain fuses into ONE Layer.color, zero filter passes', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'sepia' }, { type: 'contrast', amount: 1.2 }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const l = layer0(r);
    expect(l.color).toBeDefined();
    expect(l.filters).toBeUndefined();
  });

  it('grayscale lowers to the saturation-0 matrix', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'grayscale' }] }],
      output: av,
    }), FACTS);
    const m = layer0(r).color!.matrix;
    // rank-1 luma rows: all three rows equal the Rec.709 weights
    expect(m.slice(0, 3)).toEqual(m.slice(3, 6));
    expect(m[0]).toBeCloseTo(0.2126, 4);
  });

  it('duotone is affine (rank-1 ramp + offset), no passes', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'duotone', shadow: '#1a1a40', highlight: '#ffcc88' }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const l = layer0(r);
    expect(l.color).toBeDefined();
    expect(l.color!.offset[2]).toBeCloseTo(0x40 / 255, 4);
    expect(l.filters).toBeUndefined();
  });

  it('a pass step demotes the whole chain to filters in authored order', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'sepia' }, { type: 'blur', radius: 4 }, { type: 'brightness', amount: 1.1 }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    const l = layer0(r);
    expect(l.color).toBeUndefined();  // ordering: sepia must run BEFORE blur
    expect(l.filters!.map((f) => f.op)).toEqual(['colorMatrix', 'blur', 'colorMatrix']);
  });

  it('consecutive affines around a pass step fuse per run', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [
        { type: 'sepia' }, { type: 'contrast', amount: 1.1 },
        { type: 'grain' },
        { type: 'invert' }, { type: 'brightness', amount: 0.9 },
      ] }],
      output: av,
    }), FACTS);
    expect(layer0(r).filters!.map((f) => f.op)).toEqual(['colorMatrix', 'grain', 'colorMatrix']);
  });

  it('levels: affine without gamma, a pass step with gamma', () => {
    const flat = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'levels', black: 0.1, white: 0.9 }] }],
      output: av,
    }), FACTS);
    expect(layer0(flat).color).toBeDefined();
    expect(layer0(flat).filters).toBeUndefined();
    const gamma = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'levels', gamma: 1.8 }] }],
      output: av,
    }), FACTS);
    expect(layer0(gamma).filters).toEqual([{ op: 'levels', inBlack: 0, inWhite: 1, gamma: 1.8 }]);
  });

  it('pixelate defaults its block size from the chain geometry', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'pixelate' }] }],
      output: av,
    }), FACTS);
    // 320x180 source → max(8, round(180/40)) = 8
    expect(layer0(r).filters).toEqual([{ op: 'pixelate', size: 8 }]);
  });

  it('top-level non-affine effects land in composite.postFilters on every span', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'image', source: 'logo', place: { anchor: 'top-right', width: '10%' }, placementSource: 'user', from: 2, to: 5 }],
      effects: [{ type: 'grain', amount: 0.4 }, { type: 'vignette' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans.length).toBeGreaterThan(1);
    for (const span of r.plan!.spans) {
      expect(span.video!.composite.postFilters!.map((f) => f.op)).toEqual(['grain', 'vignette']);
    }
    expect(r.plan!.spans[0]!.video!.composite.layers[0]!.color).toBeUndefined();
  });

  it('top-level all-affine still rides per-layer color (no postFilters)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'temperature', amount: 0.3 }],
      output: av,
    }), FACTS);
    expect(r.plan!.spans[0]!.video!.composite.postFilters).toBeUndefined();
    expect(layer0(r).color).toBeDefined();
  });

  it('any filter breaks video copy', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'grain' }],
      output: av,
    }), FACTS);
    expect(r.plan!.strategy.video).toBe('reencode');
  });

  it('photo + grayscale + vignette → filtered still (the arc headline)', () => {
    const facts: FactsTable = { ...FACTS, photo: { kind: 'image', duration: Infinity, image: { width: 800, height: 600 } } };
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'photo', effects: [{ type: 'grayscale' }, { type: 'vignette' }] }],
      output: { container: 'png' },
    }, { photo: { kind: 'image' } }), facts);
    expect(r.errors).toEqual([]);
    const l = r.plan!.spans[0]!.video!.composite.layers[0]!;
    expect(l.filters!.map((f) => f.op)).toEqual(['colorMatrix', 'vignette']);
    expect(r.plan!.spans[0]!.video!.staticSlots).toEqual({ 0: 'photo' });
  });
});

describe('plan(): named looks [E7] expand to engine-owned recipes', () => {
  const layer0 = (r: ReturnType<typeof plan>) => r.plan!.spans[0]!.video!.composite.layers[0]!;

  it('vintage → fused affine run + grain + vignette passes', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'look', name: 'vintage' }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(layer0(r).filters!.map((f) => f.op)).toEqual(['colorMatrix', 'grain', 'vignette']);
  });

  it('noir at half amount still fuses its affine family', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'look', name: 'noir', amount: 0.5 }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(layer0(r).filters!.map((f) => f.op)).toEqual(['colorMatrix', 'vignette']);
  });

  it('amount 0 is neutral-ish: recipes lerp toward identity', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'look', name: 'faded', amount: 0 }] }],
      output: av,
    }), FACTS);
    // faded is all-affine → one fused Layer.color; at amount 0 it is identity
    const c = layer0(r).color!;
    expect(c.matrix[0]).toBeCloseTo(1, 5);
    expect(c.matrix[4]).toBeCloseTo(1, 5);
    expect(c.offset[0]).toBeCloseTo(0, 5);
  });
});

describe('plan(): CFR conform [D5]', () => {
  it('output.fps is accepted for decoded video and lands on the plan', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: { ...av, fps: 15 } }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.fps).toBe(15);
  });

  it('an fps request breaks video copy — conform is an encode', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: { ...av, fps: 24 } }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.strategy.video).toBe('reencode');
  });

  it('fps on a single-frame output is rejected', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', at: 1, fps: 10 },
    }), FACTS);
    expect(r.errors.some((e) => e.path.includes('output.fps'))).toBe(true);
  });

  it('fps out of range is rejected', () => {
    const r = plan(doc({ timeline: [{ type: 'clip', source: 'a' }], output: { ...av, fps: 500 } }), FACTS);
    expect(r.errors.some((e) => e.path.includes('output.fps'))).toBe(true);
  });
});

describe('plan(): audio leveling [H4]', () => {
  it('level effect lowers to the level audio-kernel and breaks audio copy', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'level', target: -14 }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.audioKernels).toEqual([{ op: 'level', params: { target: -14 } }]);
    expect(r.plan!.strategy.audio).toBe('reencode');
    expect(r.plan!.strategy.video).toBe('copy'); // video lane untouched
  });

  it('denoise + level chain in order (level after denoise)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'denoise' }, { type: 'level' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.audioKernels!.map((k) => k.op)).toEqual(['denoise', 'level']);
  });

  it('level without an audio track is rejected honestly', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'level' }],
      output: { container: 'mp4', video: {} },
    }), FACTS);
    expect(r.errors.some((e) => /level requires an audio track/.test(e.message))).toBe(true);
  });
});

describe('plan(): qrcode generator op [Q1]', () => {
  it('standalone: one source-less qr step, png delivery, no requirements', async () => {
    const r = plan({
      version: '0.1', assets: {},
      operations: [{ id: 'code', op: 'qrcode', text: 'https://katana.video' }],
    }, {});
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps).toEqual([{
      kind: 'qr', id: 'code',
      params: { text: 'https://katana.video', ec: 'medium', size: 1024 },
      format: 'png',
    }]);
    expect(r.pipeline!.deliver).toBe('code');
    const { pipelineRequirements } = await import('../src/pipeline-info');
    expect(pipelineRequirements(r.pipeline!)).toEqual([]);
  });

  it('composes as an overlay source: the render sees a size×size image artifact', () => {
    const r = plan({
      version: '0.1', assets: { a: { kind: 'video' } },
      operations: [
        { id: 'code', op: 'qrcode', text: 'https://katana.video', size: 256, ec: 'high' },
        {
          id: 'out', op: 'render',
          timeline: [{ type: 'clip', source: 'a' }],
          overlays: [{
            type: 'image', source: 'code', placementSource: 'user',
            place: { anchor: 'bottom-right', margin: '4%', width: '20%' },
          }],
          output: { container: 'mp4', video: {}, audio: {} },
        },
      ],
    }, FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.steps.map((s) => s.kind)).toEqual(['qr', 'render']);
    expect(r.pipeline!.deliver).toBe('out');
    // 20% of the 320px canvas, square artifact → square placement
    const slots = r.plan!.spans[0]!.video!.staticSlots!;
    expect(Object.values(slots)).toContain('code');
  });

  it('rejects a qrcode id referenced before schema-invalid shapes reach lower', () => {
    const r = plan({
      version: '0.1', assets: {},
      operations: [{ id: 'code', op: 'qrcode', text: '' }],
    }, {});
    expect(r.errors.some((e) => e.code === 'schema-invalid')).toBe(true);
  });
});

describe('plan(): solid backgrounds — output.background + pad color', () => {
  const BG_FACTS: FactsTable = {
    ...FACTS,
    photo: { kind: 'image', duration: Infinity, image: { width: 800, height: 600 } },
    photo2: { kind: 'image', duration: Infinity, image: { width: 640, height: 480 } },
  };
  const assets = { photo: { kind: 'image' }, photo2: { kind: 'image' }, a: { kind: 'video' }, logo: { kind: 'image' } };
  const pipeDoc = (operations: unknown[]) => ({ version: '0.1', assets, operations });
  const GREEN: [number, number, number] = [0, 1, 0];

  it('removebg cut-out → png on a solid color (the live ask: "replace the background with green")', () => {
    const r = plan(pipeDoc([
      { id: 'cut', op: 'removebg', source: 'photo' },
      { id: 'out', op: 'render', timeline: [{ type: 'clip', source: 'cut' }], output: { container: 'png', background: '#00ff00' } },
    ]), BG_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.canvas).toEqual({ w: 800, h: 600 });
    expect(r.plan!.spans[0]!.video!.composite.background).toEqual(GREEN);
  });

  it('several images: one cut-out + one render each, every render a deliverable', () => {
    const r = plan(pipeDoc([
      { id: 'cut1', op: 'removebg', source: 'photo' },
      { id: 'cut2', op: 'removebg', source: 'photo2' },
      { id: 'r1', op: 'render', timeline: [{ type: 'clip', source: 'cut1' }], output: { container: 'png', background: '#00ff00' } },
      { id: 'r2', op: 'render', timeline: [{ type: 'clip', source: 'cut2' }], output: { container: 'png', background: '#00ff00' } },
    ]), BG_FACTS);
    expect(r.errors).toEqual([]);
    expect(r.pipeline!.deliverables).toEqual(['r1', 'r2']);
    for (const step of r.pipeline!.steps) {
      if (step.kind === 'render') expect(step.plan.spans[0]!.video!.composite.background).toEqual(GREEN);
    }
  });

  it('transformImage pad color now fills (was an unsupported-in-v01 error)', () => {
    const r = plan(pipeDoc([
      { id: 'cut', op: 'removebg', source: 'photo' },
      { id: 'sq', op: 'transformImage', source: 'cut', effects: [{ type: 'pad', aspect: '1:1', color: '#000000' }] },
    ]), BG_FACTS);
    expect(r.errors).toEqual([]);
    const step = r.pipeline!.steps.find((s) => s.id === 'sq');
    if (step?.kind !== 'transformImage') throw new Error('no transformImage step');
    expect(step.plan.canvas).toEqual({ w: 800, h: 800 });
    // explicit black is opaque black now — before, still bars came out transparent
    expect(step.plan.spans[0]!.video!.composite.background).toEqual([0, 0, 0]);
  });

  it("pad color on video bars; a base pad's color beats output.background", () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'pad', aspect: '9:16', color: '#ffffff' }] }],
      output: { ...av, background: '#00ff00' },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[0]!.video!.composite.background).toEqual([1, 1, 1]);
  });

  it('top-level pad color fills the composed output', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'pad', aspect: '1:1', color: '#0000ff' }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[0]!.video!.composite.background).toEqual([0, 0, 1]);
  });

  it('no color anywhere → no background key (renderer defaults unchanged)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'pad', aspect: '9:16' }] }],
      output: av,
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.spans[0]!.video!.composite).not.toHaveProperty('background');
  });

  it('pad color on a NON-base composition layer is an honest error', () => {
    const r = plan(doc({
      timeline: [{
        type: 'composition', layers: [
          { type: 'video', source: 'a' },
          { type: 'image', source: 'logo', place: { anchor: 'top-left' }, effects: [{ type: 'pad', aspect: '1:1', color: '#ff0000' }] },
        ],
      }],
      output: av,
    }), FACTS);
    expect(r.errors.map((e) => e.code)).toContain('unsupported-in-v01');
  });
});

describe('plan(): voice enhancement kernel [enhance]', () => {
  it('top-level enhance → an audio kernel at 48 kHz; video stream-copies', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'enhance' }],
      output: { container: 'mp4', video: { codec: 'auto' }, audio: { codec: 'auto' } },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.audioKernels).toEqual([{ op: 'enhance', params: {} }]);
    expect(r.plan!.audioFormat!.rate).toBe(48000);
    expect(r.plan!.strategy.video).toBe('copy');
    expect(r.plan!.strategy.audio).toBe('reencode');
  });

  it('enhance + level chain in that order', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'music' }],
      effects: [{ type: 'level' }, { type: 'enhance' }],
      output: { container: 'wav' },
    }), FACTS);
    expect(r.errors).toEqual([]);
    expect(r.plan!.audioKernels!.map((k) => k.op)).toEqual(['enhance', 'level']);
  });

  it('enhance with denoise is an honest error (enhance already denoises)', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'music' }],
      effects: [{ type: 'denoise' }, { type: 'enhance' }],
      output: { container: 'wav' },
    }), FACTS);
    expect(r.errors.map((e) => e.code)).toContain('unsupported-in-v01');
  });

  it('enhance below the top level is rejected [H1]', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'enhance' }] }],
      output: av,
    }), FACTS);
    expect(r.errors.map((e) => e.code)).toContain('unsupported-in-v01');
  });

  it('enhance needs an audio track in the output', () => {
    const r = plan(doc({
      timeline: [{ type: 'clip', source: 'a' }],
      effects: [{ type: 'enhance' }],
      output: { container: 'mp4', video: {} },
    }), FACTS);
    expect(r.errors.map((e) => e.code)).toContain('usage-unavailable');
  });
});
