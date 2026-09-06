/**
 * Computed facts — decode-time probes [front-door P4]. The static layer
 * (probe.ts) reads headers in milliseconds; these DECODE media to answer what
 * headers can't: "is the audio silent?", "is this file damaged?".
 *
 * Like MediaFacts, results are PROMPT SURFACE: flat, stable, self-describing
 * field names — a language model reads this JSON verbatim and phrases the
 * answer. The load-bearing distinction in decodeHealth: `undecodable-here`
 * (the codec isn't available in THIS browser — the file may be perfectly
 * fine elsewhere) is NOT `damaged` (a supported codec failed mid-stream —
 * evidence of real corruption).
 *
 * Browser-only (WebCodecs decode). Callers own cost: audioStats decodes the
 * audio track (bounded by maxSeconds); decodeHealth decodes short windows at
 * the start / middle / end of every decodable track.
 */

import { Input, BlobSource, ALL_FORMATS, AudioSampleSink, VideoSampleSink } from 'mediabunny';
import { extractPlanar } from './nodes/audio';

// ---------------------------------------------------------------------------
// audioStats
// ---------------------------------------------------------------------------

export interface SilentSegment { start: number; end: number }

export interface AudioStatsFacts {
  probe: 'audioStats';
  /** Overall RMS / true peak in dBFS (floored at -120; -120 ≈ digital silence). */
  rmsDb: number;
  peakDb: number;
  channels: number;
  sampleRate: number;
  /** Seconds actually decoded (min(duration, the maxSeconds bound)). */
  analyzedSeconds: number;
  /** Segments whose 100 ms windows all stay under silenceThresholdDb. */
  silenceThresholdDb: number;
  silentSegments: SilentSegment[];
  /** 0..1 fraction of the analyzed span that is silent. 1 = entirely silent. */
  silentFraction: number;
}

const db = (linear: number): number =>
  linear <= 1e-6 ? -120 : Math.max(-120, Math.round(20 * Math.log10(linear) * 10) / 10);

export async function probeAudioStats(
  source: Blob,
  opts: { thresholdDb?: number; maxSeconds?: number } = {},
): Promise<AudioStatsFacts> {
  const thresholdDb = opts.thresholdDb ?? -50;
  const maxSeconds = opts.maxSeconds ?? 600;
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('no audio track to analyze');
  const duration = Math.min(await input.computeDuration(), maxSeconds);

  const BUCKET = 0.1; // seconds per RMS window
  const bucketSum: number[] = [];
  const bucketCount: number[] = [];
  let peak = 0;
  let analyzedEnd = 0;

  const sink = new AudioSampleSink(track);
  for await (const s of sink.samples(0, duration)) {
    const chans = extractPlanar(s, Math.min(2, s.numberOfChannels));
    const rate = s.sampleRate;
    for (const ch of chans) {
      for (let i = 0; i < ch.length; i++) {
        const v = ch[i]!;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        const bi = Math.floor((s.timestamp + i / rate) / BUCKET);
        bucketSum[bi] = (bucketSum[bi] ?? 0) + v * v;
        bucketCount[bi] = (bucketCount[bi] ?? 0) + 1;
      }
    }
    analyzedEnd = Math.max(analyzedEnd, s.timestamp + s.numberOfFrames / rate);
    s.close();
  }

  // bucket RMS → silence run-length merge
  let sumSquares = 0;
  let n = 0;
  const silent: SilentSegment[] = [];
  let runStart: number | null = null;
  for (let bi = 0; bi < bucketSum.length; bi++) {
    const count = bucketCount[bi] ?? 0;
    const rms = count ? Math.sqrt((bucketSum[bi] ?? 0) / count) : 0;
    sumSquares += bucketSum[bi] ?? 0;
    n += count;
    const isSilent = db(rms) < thresholdDb;
    if (isSilent && runStart === null) runStart = bi * BUCKET;
    if (!isSilent && runStart !== null) {
      silent.push({ start: round2(runStart), end: round2(bi * BUCKET) });
      runStart = null;
    }
  }
  if (runStart !== null) silent.push({ start: round2(runStart), end: round2(analyzedEnd) });
  const silentTotal = silent.reduce((acc, seg) => acc + (seg.end - seg.start), 0);

  return {
    probe: 'audioStats',
    rmsDb: db(n ? Math.sqrt(sumSquares / n) : 0),
    peakDb: db(peak),
    channels: track.numberOfChannels,
    sampleRate: track.sampleRate,
    analyzedSeconds: round2(analyzedEnd),
    silenceThresholdDb: thresholdDb,
    silentSegments: silent.slice(0, 50),
    silentFraction: analyzedEnd > 0 ? Math.min(1, round2(silentTotal / analyzedEnd)) : 1,
  };
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// decodeHealth
// ---------------------------------------------------------------------------

export interface TrackHealth {
  kind: 'video' | 'audio';
  id: number;
  codec: string | null;
  /** false = this BROWSER lacks the codec — says nothing about the file. */
  decodableOnThisDevice: boolean;
  /** Samples decoded across the test windows (start/middle/end). */
  samplesDecoded: number;
  decodeErrors: number;
  firstError: string | null;
}

export interface DecodeHealthFacts {
  probe: 'decodeHealth';
  /** false = the container itself could not be parsed (headers unreadable). */
  readableContainer: boolean;
  /**
   * 'healthy'          — every track decodable here and windows decoded clean
   * 'undecodable-here' — codec(s) unavailable in this browser; the FILE may
   *                      be fine (e.g. divx/mpeg4 in Chrome) — do not call it
   *                      corrupt
   * 'damaged'          — a codec this browser supports failed mid-decode or
   *                      produced nothing: evidence of file corruption
   * 'unreadable'       — the container didn't parse at all
   */
  verdict: 'healthy' | 'undecodable-here' | 'damaged' | 'unreadable';
  container: string | null;
  tracks: TrackHealth[];
}

export async function probeDecodeHealth(source: Blob): Promise<DecodeHealthFacts> {
  const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
  let container: string | null = null;
  let duration = 0;
  let tracks: Awaited<ReturnType<typeof input.getTracks>>;
  try {
    container = (await input.getFormat()).name;
    duration = await input.computeDuration();
    tracks = await input.getTracks();
    if (!tracks.length) throw new Error('no tracks');
  } catch {
    return { probe: 'decodeHealth', readableContainer: false, verdict: 'unreadable', container, tracks: [] };
  }

  const health: TrackHealth[] = [];
  for (const track of tracks) {
    if (!track.isVideoTrack() && !track.isAudioTrack()) continue;
    const kind = track.isVideoTrack() ? 'video' as const : 'audio' as const;
    const decodable = await track.canDecode().catch(() => false);
    const h: TrackHealth = {
      kind, id: track.id, codec: track.codec ?? null,
      decodableOnThisDevice: decodable,
      samplesDecoded: 0, decodeErrors: 0, firstError: null,
    };
    if (decodable) {
      // Short windows at the start, middle, and near the end — enough to
      // catch truncation and mid-stream damage without decoding everything.
      // Missing media data rarely throws: the demuxer answers with the
      // nearest EARLIER frame (timestamp outside the window) or a sparse
      // trickle — so count only IN-WINDOW samples and compare each window's
      // density against the first one.
      const WINDOW = kind === 'video' ? 1 : 2;
      const starts = duration > WINDOW * 3
        ? [0, duration / 2, Math.max(0, duration - WINDOW * 1.5)]
        : [0];
      let baseline = 0;
      for (const at of starts) {
        const winEnd = Math.min(duration, at + WINDOW);
        let got = 0;
        try {
          const sink = track.isVideoTrack() ? new VideoSampleSink(track) : new AudioSampleSink(track);
          for await (const s of sink.samples(at, winEnd)) {
            if (s.timestamp >= at - 0.05) got++;
            s.close();
          }
        } catch (err) {
          h.decodeErrors++;
          h.firstError ??= err instanceof Error ? err.message : String(err);
        }
        h.samplesDecoded += got;
        if (at === starts[0]) baseline = got;
        const tag = `${Math.round(at * 10) / 10}s`;
        if (got === 0 && winEnd - at > 0.2) {
          h.decodeErrors++;
          h.firstError ??= `the window at ${tag} decoded no samples (media data missing?)`;
        } else if (at !== starts[0] && baseline >= 8 && got < baseline * 0.25) {
          h.decodeErrors++;
          h.firstError ??= `the window at ${tag} decoded only ${got} samples vs ${baseline} at the start (media data missing?)`;
        }
      }
    }
    health.push(h);
  }

  const anyDamage = health.some((h) => h.decodableOnThisDevice && h.decodeErrors > 0);
  const anyUnsupported = health.some((h) => !h.decodableOnThisDevice);
  return {
    probe: 'decodeHealth',
    readableContainer: true,
    verdict: anyDamage ? 'damaged' : anyUnsupported ? 'undecodable-here' : 'healthy',
    container,
    tracks: health,
  };
}
