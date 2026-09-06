/**
 * Pins codec-tables.ts (pure, planner-side) to mediabunny's real muxer
 * support (executor-side). canCopyCodec answers from the static prefs table
 * alone; this test proves every pref is muxer-legal and that the table-only
 * answer equals the old two-gate (prefs ∩ getSupported*Codecs) answer for a
 * universe of codecs. If a mediabunny upgrade changes muxer support, this
 * fails and the table gets re-derived — the layers never silently disagree.
 */
import { describe, expect, it } from 'vitest';
import { CONTAINERS } from '../src/containers';
import { AUDIO_PREFS, VIDEO_PREFS, canCopyCodec, type ContainerId } from '../src/codec-tables';

const IDS = Object.keys(CONTAINERS) as ContainerId[];
const VIDEO_UNIVERSE = ['avc', 'hevc', 'vp8', 'vp9', 'av1', null, undefined, 'divx'];
const AUDIO_UNIVERSE = ['aac', 'opus', 'mp3', 'vorbis', 'flac', 'pcm-s16', 'pcm-f32', null, undefined];

describe('codec-tables stays in lockstep with mediabunny muxers', () => {
  it('every pref is actually muxer-supported', () => {
    for (const id of IDS) {
      const format = CONTAINERS[id]();
      for (const c of VIDEO_PREFS[id] ?? []) {
        expect(format.getSupportedVideoCodecs(), `${id} video ${c}`).toContain(c);
      }
      for (const c of AUDIO_PREFS[id] ?? []) {
        expect(format.getSupportedAudioCodecs(), `${id} audio ${c}`).toContain(c);
      }
    }
  });

  it('table-only canCopyCodec equals the two-gate answer', () => {
    for (const id of IDS) {
      const format = CONTAINERS[id]();
      for (const c of VIDEO_UNIVERSE) {
        const twoGate = !!c && ((VIDEO_PREFS[id] ?? []) as readonly string[]).includes(c)
          && (format.getSupportedVideoCodecs() as readonly string[]).includes(c);
        expect(canCopyCodec(id, 'video', c), `${id} video ${c}`).toBe(twoGate);
      }
      for (const c of AUDIO_UNIVERSE) {
        const twoGate = !!c && ((AUDIO_PREFS[id] ?? []) as readonly string[]).includes(c)
          && (format.getSupportedAudioCodecs() as readonly string[]).includes(c);
        expect(canCopyCodec(id, 'audio', c), `${id} audio ${c}`).toBe(twoGate);
      }
    }
  });
});
