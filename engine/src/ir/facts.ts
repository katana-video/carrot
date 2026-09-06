/**
 * AssetFacts — the planner-facing slice of MediaFacts [P3]. Pure data, no
 * browser dependencies (the planner runs in Node for tests); the harness maps
 * probe() output into this shape.
 *
 * codec/rotation feed the stream-copy negotiation [D1]; when absent (older
 * callers, hand-authored fixtures) the planner conservatively re-encodes.
 */

import type { MediaFacts } from '../probe';

export interface AssetFacts {
  kind: 'video' | 'audio' | 'image' | 'timed-text';
  /** Seconds; Infinity for images. */
  duration: number;
  video?: {
    width: number; height: number;
    /** Mediabunny codec id ('avc', 'hevc', …); required for copy eligibility. */
    codec?: string;
    /** Display rotation metadata; copy is only eligible at 0 (the re-encode
     * path bakes rotation into pixels; copy would have to trust the target
     * container's rotation metadata, which v0.1 does not). */
    rotation?: number;
    /** First packet timestamp; copy requires >= 0 (edit-list lead-in like AAC
     * priming cannot be expressed on output — Mediabunny's own Conversion
     * makes the same call). Absent = copy-ineligible. */
    firstTimestamp?: number;
  };
  audio?: { sampleRate: number; channels: number; codec?: string; firstTimestamp?: number };
  image?: { width: number; height: number };
  /** The file ends mid-box (probe.ts detectTruncatedTail) — the reader was
   * handed fewer bytes than the container declares. When the missing tail
   * held the moov, video/audio are absent too despite real media inside. */
  truncated?: boolean;
}

export type FactsTable = Record<string, AssetFacts>;

/** Map a probe() result to planner facts. Image assets bypass probe (bitmap dims). */
export function factsFromProbe(facts: MediaFacts): AssetFacts {
  const video = facts.tracks.find((t) => t.kind === 'video');
  const audio = facts.tracks.find((t) => t.kind === 'audio');
  const out: AssetFacts = {
    kind: video ? 'video' : 'audio',
    duration: facts.duration,
  };
  if (video && video.kind === 'video') {
    out.video = {
      width: video.displayWidth, height: video.displayHeight,
      rotation: video.rotation, firstTimestamp: video.firstTimestamp,
    };
    if (video.codec) out.video.codec = video.codec;
  }
  if (audio && audio.kind === 'audio') {
    out.audio = {
      sampleRate: audio.sampleRate, channels: audio.channels,
      firstTimestamp: audio.firstTimestamp,
    };
    if (audio.codec) out.audio.codec = audio.codec;
  }
  if (facts.truncatedTail) out.truncated = true;
  return out;
}

export function imageFacts(width: number, height: number): AssetFacts {
  return { kind: 'image', duration: Infinity, image: { width, height } };
}

/** Timed-text (subtitle) assets bypass probe — the planner only wires them. */
export function timedTextFacts(): AssetFacts {
  return { kind: 'timed-text', duration: 0 };
}
