/**
 * probe() — the engine's ffprobe-equivalent (static facts layer).
 *
 * Two-layer fact model (design doc):
 * - STATIC facts (this module): container, tracks, codecs, geometry, duration,
 *   per-track decodability on THIS device. Header/index reads only —
 *   milliseconds, no media decode. Safe to run unconditionally on every asset;
 *   the result is injected into the NL compiler's context so conditionals
 *   ("does it have audio?") collapse at compile time.
 * - COMPUTED facts (future analysis ops): loudness (LUFS), peak levels,
 *   silence maps, spoken language. Cost real decode time; they arrive later as
 *   registry ops producing typed fact artifacts, requested via staged planning.
 *
 * MediaFacts is PROMPT SURFACE as well as API: field names are stable, flat,
 * and self-describing, because language models read this JSON verbatim.
 *
 * Known gap: Mediabunny does not currently support reading subtitle tracks —
 * `tracks` will not report them. (Upstream candidate.)
 */

import { Input, BlobSource, ALL_FORMATS } from 'mediabunny';
import type { Sec } from './schema';

export interface VideoTrackFacts {
  kind: 'video';
  id: number;
  /** Mediabunny codec id ('avc', 'hevc', 'vp9', …) or null if unrecognized. */
  codec: string | null;
  /** Full codec parameter string ('avc1.42c032') when available. */
  codecString: string | null;
  /** Whether THIS device can decode the track (device-dependent fact). */
  decodable: boolean;
  codedWidth: number;
  codedHeight: number;
  /** After rotation/aspect adjustment — the geometry the engine plans with. */
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  /** Average frame rate, sampled from packet stats. */
  fps: number | null;
  averageBitrate: number | null;
  /** ISO 639-2 language code; null when unset ('und'). */
  language: string | null;
  /** First packet's presentation timestamp, seconds. Negative for tracks with
   * edit-list lead-in (AAC priming) — such tracks are not stream-copyable. */
  firstTimestamp: number;
}

export interface AudioTrackFacts {
  kind: 'audio';
  id: number;
  codec: string | null;
  codecString: string | null;
  decodable: boolean;
  channels: number;
  sampleRate: number;
  averageBitrate: number | null;
  language: string | null;
  firstTimestamp: number;
}

export type TrackFacts = VideoTrackFacts | AudioTrackFacts;

export interface MediaFacts {
  /** Container format short name, e.g. 'MP4', 'WebM', 'Matroska', 'WAVE'. */
  container: string;
  mimeType: string | null;
  duration: Sec;
  fileSizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
  tracks: TrackFacts[];
  /** Set when the file ENDS mid-box (ISO-BMFF only): the reader was handed
   * fewer bytes than the container declares. Seen live 2026-08-10: Android's
   * media provider serves a stale-size (truncated) copy of freshly recorded
   * Samsung voice memos — the tail `moov` is cut, so the file demuxes to
   * ZERO tracks even though the on-disk original is fine. */
  truncatedTail?: { box: string; declaredBytes: number; presentBytes: number };
}

const nullableLanguage = (code: string): string | null =>
  code && code !== 'und' ? code : null;

/**
 * ISO-BMFF top-level walk: does the file end mid-box? Header reads only (a
 * few 16-byte slices; mdat is skipped via its size field). Returns undefined
 * for non-BMFF containers (no 'ftyp') and for merely-unusual structures —
 * this detects exactly one thing: a byte count shorter than declared.
 */
export async function detectTruncatedTail(source: Blob): Promise<MediaFacts['truncatedTail']> {
  const header = async (off: number): Promise<{ size: number; type: string } | null> => {
    if (off + 8 > source.size) return null;
    const view = new DataView(await source.slice(off, Math.min(off + 16, source.size)).arrayBuffer());
    let size: number = view.getUint32(0);
    const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
    if (size === 1) {
      if (view.byteLength < 16) return { size: NaN, type };
      size = Number(view.getBigUint64(8));
    } else if (size === 0) {
      size = source.size - off; // "extends to end of file" — valid, never truncated
    }
    return { size, type };
  };
  const first = await header(0);
  if (!first || first.type !== 'ftyp') return undefined;
  let off = 0;
  while (off < source.size) {
    const h = await header(off);
    if (!h) return { box: '(box header)', declaredBytes: 8, presentBytes: source.size - off };
    if (!Number.isFinite(h.size) || h.size < 8) return undefined; // malformed some OTHER way — not this detector's call
    if (off + h.size > source.size) {
      return { box: h.type, declaredBytes: h.size, presentBytes: source.size - off };
    }
    off += h.size;
  }
  return undefined;
}

/**
 * Probe a media blob for static facts. Fast (header + packet-index reads).
 * `packetStatsSampleCount` bounds the packets sampled for fps/bitrate
 * estimates; 0 disables stats entirely (fastest).
 */
export async function probe(source: Blob, packetStatsSampleCount = 100): Promise<MediaFacts> {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });

  const [format, mimeType, duration, tracks] = await Promise.all([
    input.getFormat(),
    input.getMimeType().catch(() => null),
    input.computeDuration(),
    input.getTracks(),
  ]);

  const trackFacts: TrackFacts[] = [];
  for (const track of tracks) {
    const [codec, codecString, decodable, firstTimestamp] = await Promise.all([
      Promise.resolve(track.codec),
      track.getCodecParameterString().catch(() => null),
      track.canDecode().catch(() => false),
      track.getFirstTimestamp().catch(() => 0),
    ]);
    const stats = packetStatsSampleCount > 0
      ? await track.computePacketStats(packetStatsSampleCount).catch(() => null)
      : null;

    if (track.isVideoTrack()) {
      trackFacts.push({
        kind: 'video',
        id: track.id,
        codec: codec ?? null,
        codecString,
        decodable,
        codedWidth: track.codedWidth,
        codedHeight: track.codedHeight,
        displayWidth: track.displayWidth,
        displayHeight: track.displayHeight,
        rotation: track.rotation,
        fps: stats ? Math.round(stats.averagePacketRate * 100) / 100 : null,
        averageBitrate: stats ? Math.round(stats.averageBitrate) : null,
        language: nullableLanguage(track.languageCode),
        firstTimestamp,
      });
    } else if (track.isAudioTrack()) {
      trackFacts.push({
        kind: 'audio',
        id: track.id,
        codec: codec ?? null,
        codecString,
        decodable,
        channels: track.numberOfChannels,
        sampleRate: track.sampleRate,
        averageBitrate: stats ? Math.round(stats.averageBitrate) : null,
        language: nullableLanguage(track.languageCode),
        firstTimestamp,
      });
    }
    // subtitle tracks: not readable in current Mediabunny — see module docs
  }

  const truncatedTail = await detectTruncatedTail(source);

  return {
    container: format.name,
    mimeType,
    duration,
    fileSizeBytes: source.size,
    hasVideo: trackFacts.some((t) => t.kind === 'video'),
    hasAudio: trackFacts.some((t) => t.kind === 'audio'),
    tracks: trackFacts,
    ...(truncatedTail ? { truncatedTail } : {}),
  };
}
