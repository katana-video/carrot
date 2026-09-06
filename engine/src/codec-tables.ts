/**
 * Pure codec/container tables — NO mediabunny import, so the planner
 * (ir/lower runs on the main thread for the review UI) stays out of the
 * muxer bundle. The executor's format factories live in containers.ts.
 *
 * canCopyCodec answers stream-copy legality [D1] from these tables alone.
 * Every pref below is verified against mediabunny's actual muxer support
 * lists by test/codec-tables.test.ts — if a mediabunny upgrade changes what
 * a muxer accepts, that test fails and this table gets re-derived, instead
 * of the two layers silently disagreeing.
 */

export type ContainerId = 'mp4' | 'webm' | 'mkv' | 'mp3' | 'wav' | 'ogg';

/** Literal subsets of mediabunny's VideoCodec/AudioCodec unions — typed
 * locally so this module needs no mediabunny import; assignability into the
 * executor's typed APIs is checked where they're consumed. */
type CopyVideoCodec = 'avc' | 'hevc' | 'vp8' | 'vp9' | 'av1';
type CopyAudioCodec = 'aac' | 'opus' | 'mp3' | 'pcm-s16' | 'vorbis';

/** Encode-preference order per container; first encodable wins. Also the
 * playback-safe subset for stream copy (e.g. PCM-in-MP4 is muxer-legal but
 * widely unplayable, so it is deliberately absent). */
export const VIDEO_PREFS: Partial<Record<ContainerId, CopyVideoCodec[]>> = {
  mp4: ['avc', 'hevc', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
  mkv: ['avc', 'vp9', 'av1'],
};

export const AUDIO_PREFS: Partial<Record<ContainerId, CopyAudioCodec[]>> = {
  mp4: ['aac', 'opus'],
  webm: ['opus'],
  mkv: ['aac', 'opus'],
  mp3: ['mp3'],
  wav: ['pcm-s16'],
  // encode negotiation lands on opus (no WebCodecs vorbis encoder); vorbis
  // is listed for stream-copy legality (vorbis-in-ogg remuxes untouched)
  ogg: ['opus', 'vorbis'],
};

/** Stream-copy legality [D1]: the source codec must be playback-safe for the
 * container (prefs list) — and the pinned test guarantees every pref is also
 * muxer-supported, so one table answers for both gates. */
export function canCopyCodec(
  container: ContainerId,
  kind: 'video' | 'audio',
  codec: string | null | undefined,
): boolean {
  if (!codec) return false;
  const prefs: readonly string[] | undefined =
    kind === 'video' ? VIDEO_PREFS[container] : AUDIO_PREFS[container];
  return prefs?.includes(codec) ?? false;
}
