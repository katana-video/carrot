/**
 * IR-document harness cases — end-to-end: document → plan() → execute().
 * Facts come from probe() at runtime (probe's first in-anger use).
 */

export interface DocCase {
  name: string;
  document: unknown;
  expected: {
    hasVideo: boolean;
    hasAudio: boolean;
    w?: number;
    h?: number;
    dur: number;
    audioNonSilentAt?: [number, number, number][];
    /** ffprobe codec_name assertions (stream-copy cases). */
    videoCodecName?: string;
    audioCodecName?: string;
    /** ffprobe stream sample_rate assertion (resample cases; PCM only —
     * opus streams always signal 48000 regardless of encode rate). */
    audioSampleRate?: number;
    /** Single-frame image output: skip duration/audio oracles, use this
     * file extension. */
    still?: string;
    /** Run on these backends (default ['webgpu']); every oracle must pass on
     * each. Lighting cases run both to prove WGSL/GLSL agreement. */
    backends?: ('webgpu' | 'webgl2')[];
    /** ffmpeg signalstats oracles, averaged over t=[2,3]. */
    videoStats?: { yAvgMin?: number; yAvgMax?: number; satAvgMax?: number };
    /** SSIM against an ffmpeg-filtered reference built from a fixture —
     * proves per-pixel agreement with an independent implementation. */
    ssimRef?: { fixture: string; vf: string; min: number };
    /** Prove no re-encode: video packet count AND total packet bytes must
     * equal this source fixture's (stream copy is packet-identical). */
    videoPacketsMatch?: string;
    /** Soft-subtitle oracle: a subtitle stream must exist and extracting it
     * must yield text containing this string. */
    subtitleText?: string;
    /** Output file extension override (containers ffprobe can't infer). */
    ext?: string;
    /** Burn-in caption oracle: count near-white pixels (all channels > 200)
     * in `crop` (ffmpeg crop syntax w:h:x:y) at two instants — text present
     * at activeAt, absent at inactiveAt. */
    burnCheck?: { crop: string; activeAt: number; minActive: number; inactiveAt?: number; maxInactive?: number };
    /** Deriver-terminal pipeline [G3]: the deliverable is an artifact file of
     * this extension — av oracles are skipped. */
    artifact?: 'vtt' | 'srt' | 'png' | 'jpeg';
    /** Every string must appear in the artifact text (vtt/srt). */
    artifactMatch?: string[];
    /** Case-insensitive regex that must match the artifact text. */
    artifactRegex?: string;
    /** removebg oracle: alpha plane must split (transparent bg, opaque subject). */
    alphaSplit?: boolean;
    /** Denoise oracle: output mean volume at least deltaDb quieter than the
     * fixture's. */
    quieterThanFixture?: { fixture: string; deltaDb: number };
  };
}

const assets = {
  a: { kind: 'video' }, b: { kind: 'video' }, music: { kind: 'audio' }, logo: { kind: 'image' },
  subs: { kind: 'timed-text' },
};
const doc = (render: Record<string, unknown>) => ({
  version: '0.1', assets,
  operations: [{ id: 'out', op: 'render', ...render }],
});

export const DOC_CASES: DocCase[] = [
  {
    // quality/bitrate pins force the encode path [D1] — with auto codecs this
    // untouched clip would negotiate stream copy (that's doc-remux)
    name: 'doc-transcode',
    document: doc({ timeline: [{ type: 'clip', source: 'a' }], output: { container: 'mp4', video: { quality: 'medium' }, audio: { bitrate: 96000 } } }),
    expected: { hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8 },
  },
  {
    // video stream-copies into mkv; audio re-encodes (fA's AAC has priming
    // lead-in — negative first timestamp — which is copy-ineligible [D1])
    name: 'doc-remux',
    document: doc({ timeline: [{ type: 'clip', source: 'a' }], output: { container: 'mkv', video: {}, audio: {} } }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      videoCodecName: 'h264',
      videoPacketsMatch: 'fA.mp4',
      audioNonSilentAt: [[1, 6, -40]],
    },
  },
  {
    // per-track strategy divergence: video stream-copies the whole job while
    // audio re-encodes span-by-span (volume ≠ 1 breaks audio copy only)
    name: 'doc-copy-video-touch-audio',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', volume: 0.5 }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      videoCodecName: 'h264', videoPacketsMatch: 'fA.mp4',
      audioNonSilentAt: [[1, 6, -40]],
    },
  },
  {
    // speed [T3]: 2x → 4s output; audio naively resampled (440Hz → 880Hz)
    name: 'doc-speed',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', speed: 2 }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 4,
      audioNonSilentAt: [[0.5, 3.5, -40]],
    },
  },
  {
    name: 'doc-crop-aspect',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'crop', aspect: '1:1', regionSource: 'user' }] }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: { hasVideo: true, hasAudio: true, w: 180, h: 180, dur: 8 },
  },
  {
    name: 'doc-trim-symbolic',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', range: { start: -3 } }],  // last 3 seconds
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: { hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 3 },
  },
  {
    name: 'doc-crossfade',
    document: doc({
      timeline: [
        { type: 'clip', source: 'a' },
        { type: 'transition', style: 'crossfade', duration: 1 },
        { type: 'clip', source: 'b' },
      ],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 480, h: 270, dur: 12,
      audioNonSilentAt: [[1, 3, -40], [7.2, 7.8, -40], [9, 11, -40]],
    },
  },
  {
    name: 'doc-watermark-music',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [
        { type: 'image', source: 'logo', place: { anchor: 'bottom-right', margin: 8, width: '25%' }, placementSource: 'user', opacity: 0.85 },
        { type: 'audio', source: 'music', from: 0, duration: 4, volume: 0.5 },
      ],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      audioNonSilentAt: [[1, 3, -40], [5, 7, -40]],
    },
  },
  {
    name: 'doc-podcast-composition',
    document: doc({
      timeline: [
        { type: 'composition', layers: [
          { type: 'video', source: 'a' },
          { type: 'audio', source: 'music', volume: '40%' },
        ] },
        { type: 'transition', style: 'crossfade', duration: 1 },
        { type: 'clip', source: 'b' },
      ],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: { hasVideo: true, hasAudio: true, w: 480, h: 270, dur: 12, audioNonSilentAt: [[1, 3, -40]] },
  },
  {
    name: 'doc-swap-audio',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: { from: 'music' } },
    }),
    expected: { hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8, audioNonSilentAt: [[1, 6, -40]] },
  },
  {
    name: 'doc-output-effects',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }, { type: 'clip', source: 'b' }],
      effects: [{ type: 'crop', aspect: '1:1', regionSource: 'user' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: { hasVideo: true, hasAudio: true, w: 270, h: 270, dur: 13 },
  },
  {
    // gif [D9]: animated, video-only, custom encoder (resized down — GIFs are
    // palette-quantized and big)
    name: 'doc-gif',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', range: { end: 2 }, effects: [{ type: 'resize', width: 160 }] }],
      output: { container: 'gif', video: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: false, w: 160, h: 90, dur: 2,
      ext: 'gif', videoCodecName: 'gif',
    },
  },
  {
    // burn-in captions [O5]: cue text rendered into pixels (Katana's caption
    // renderer, ported); cues at 1-3s and 5-7s, gap at 3-5s
    name: 'doc-burn-subtitles',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'subs', size: '12%' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      // caption box (defaults): 80%x35% bottom with 5% margin → 256x63 at (32,108)
      burnCheck: { crop: '256:63:32:108', activeAt: 2, minActive: 100, inactiveAt: 4, maxInactive: 40 },
    },
  },
  {
    // captions compose into stills too (outline style, extracted at cue time)
    name: 'doc-burn-still',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'captions', source: 'subs', style: 'outline', size: '12%' }],
      output: { container: 'png', video: {}, at: 2 },
    }),
    expected: {
      hasVideo: true, hasAudio: false, w: 320, h: 180, dur: 0,
      still: 'png', videoCodecName: 'png',
      burnCheck: { crop: '256:63:32:108', activeAt: 0, minActive: 100 },
    },
  },
  {
    // soft subtitles [D8]: timed-text asset muxed as a selectable track
    name: 'doc-soft-subtitles',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mkv', video: {}, audio: {}, subtitles: { from: 'subs', language: 'eng' } },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      subtitleText: 'Hello subtitles',
    },
  },
  {
    // lighting [E5]: saturation 0 → grayscale (fixture baseline SATAVG ≈ 105);
    // both backends must agree
    name: 'doc-grayscale',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', effects: [{ type: 'saturation', amount: 0 }] }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      backends: ['webgpu', 'webgl2'],
      videoStats: { satAvgMax: 8 },
    },
  },
  {
    // lighting [E5]: brightness+contrast raise mean luma (baseline YAVG ≈ 121)
    name: 'doc-lighting',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', effects: [
        { type: 'brightness', amount: 1.3 },
        { type: 'contrast', amount: 1.3 },
      ] }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 8,
      backends: ['webgpu', 'webgl2'],
      // baseline (unfiltered) yAvg is 121.4; ffmpeg's reference implementation
      // of the same math lands at 125.0 (clipping + darks pulled down by
      // contrast; BT.601/709 conversion accounts for small drift)
      videoStats: { yAvgMin: 124 },
      ssimRef: {
        fixture: 'fA.mp4',
        vf: "format=rgb24,lutrgb=r='clip((((val/255)*1.3-0.5)*1.3+0.5)*255,0,255)':g='clip((((val/255)*1.3-0.5)*1.3+0.5)*255,0,255)':b='clip((((val/255)*1.3-0.5)*1.3+0.5)*255,0,255)',format=yuv420p",
        min: 0.85,
      },
    },
  },
  {
    // frame extraction [D7]: png at 4s on the output clock
    name: 'doc-frame-png',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', video: {}, at: 4 },
    }),
    expected: {
      hasVideo: true, hasAudio: false, w: 320, h: 180, dur: 0,
      still: 'png', videoCodecName: 'png',
    },
  },
  {
    // stills compose: watermark overlay present in the extracted jpeg frame
    name: 'doc-frame-watermark-jpeg',
    document: doc({
      timeline: [{ type: 'clip', source: 'a' }],
      overlays: [{ type: 'image', source: 'logo', place: { anchor: 'bottom-right', margin: 8, width: '25%' }, placementSource: 'user' }],
      output: { container: 'jpeg', video: { quality: 'high' }, at: '50%' },
    }),
    expected: {
      hasVideo: true, hasAudio: false, w: 320, h: 180, dur: 0,
      still: 'jpg', videoCodecName: 'mjpeg',
    },
  },
  {
    // resample [D6]: 44.1k source → 22.05k output; wav/pcm reports the true
    // rate (opus containers always signal 48k, so the oracle lives here)
    name: 'doc-resample',
    document: doc({
      timeline: [{ type: 'clip', source: 'music' }],
      output: { container: 'wav', audio: { sampleRate: 22050 } },
    }),
    expected: {
      hasVideo: false, hasAudio: true, dur: 10,
      audioSampleRate: 22050,
      audioNonSilentAt: [[1, 9, -40]],
    },
  },
  {
    // exercises the audio copy lane end-to-end (pcm-s16 → wav, untouched)
    name: 'doc-audio-remux',
    document: doc({ timeline: [{ type: 'clip', source: 'music' }], output: { container: 'wav', audio: {} } }),
    expected: {
      hasVideo: false, hasAudio: true, dur: 10,
      audioCodecName: 'pcm_s16le',
      audioNonSilentAt: [[1, 9, -40]],
    },
  },
  {
    name: 'doc-audio-concat',
    document: doc({
      timeline: [
        { type: 'clip', source: 'music', range: { end: 4 } },
        { type: 'clip', source: 'music', range: { start: -4 } },
      ],
      output: { container: 'wav', audio: {} },
    }),
    expected: { hasVideo: false, hasAudio: true, dur: 8, audioNonSilentAt: [[1, 7, -40]] },
  },

  // ---- tier-1 pipelines [G1/R/L/B/U/H] ------------------------------------
  {
    name: 't1-upscale-2x',
    document: doc({
      timeline: [{ type: 'clip', source: 'a', range: { end: 3 } }],
      effects: [{ type: 'upscale' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }),
    expected: {
      hasVideo: true, hasAudio: true, w: 640, h: 360, dur: 3,
      backends: ['webgpu', 'webgl2'],
      ssimRef: { fixture: 'fA.mp4', vf: 'trim=end=3,scale=640:360:flags=bicubic', min: 0.6 },
    },
  },
  {
    name: 't1-denoise',
    document: {
      version: '0.1', assets: { noisy: { kind: 'audio' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'noisy' }],
        effects: [{ type: 'denoise' }],
        output: { container: 'wav', audio: {} },
      }],
    },
    expected: {
      hasVideo: false, hasAudio: true, dur: 10.6, audioSampleRate: 48000,
      quieterThanFixture: { fixture: 'noisy.wav', deltaDb: 2 },
    },
  },
  {
    name: 't1-transcribe-vtt',
    document: {
      version: '0.1', assets: { speech: { kind: 'video' } },
      operations: [{ id: 'caps', op: 'transcribe', source: 'speech', language: 'en' }],
    },
    expected: {
      hasVideo: false, hasAudio: false, dur: 0, artifact: 'vtt',
      artifactMatch: ['WEBVTT', '-->', 'quick', 'fox'],
    },
  },
  {
    name: 't1-transcribe-burn',
    document: {
      version: '0.1', assets: { speech: { kind: 'video' } },
      operations: [
        { id: 'caps', op: 'transcribe', source: 'speech', language: 'en' },
        {
          id: 'out', op: 'render',
          timeline: [{ type: 'clip', source: 'speech' }],
          overlays: [{ type: 'captions', source: 'caps' }],
          output: { container: 'mp4', video: {}, audio: {} },
        },
      ],
    },
    expected: {
      hasVideo: true, hasAudio: true, w: 320, h: 180, dur: 3,
      burnCheck: { crop: '320:63:0:117', activeAt: 1.5, minActive: 40 },
    },
  },
  {
    name: 't1-translate-chain',
    document: {
      version: '0.1', assets: { speech: { kind: 'video' } },
      operations: [
        { id: 'caps', op: 'transcribe', source: 'speech', language: 'en' },
        { id: 'caps_es', op: 'translate', source: 'caps', to: 'es', from: 'en' },
      ],
    },
    expected: {
      hasVideo: false, hasAudio: false, dur: 0, artifact: 'vtt',
      artifactMatch: ['WEBVTT', '-->'],
      artifactRegex: 'zorro|r[áa]pido|salta|perez[oa]|sobre',
    },
  },
  {
    name: 't1-removebg',
    document: {
      version: '0.1', assets: { portrait: { kind: 'image' } },
      operations: [{ id: 'cut', op: 'removebg', source: 'portrait' }],
    },
    expected: {
      hasVideo: false, hasAudio: false, dur: 0, artifact: 'png', alphaSplit: true,
    },
  },
];
