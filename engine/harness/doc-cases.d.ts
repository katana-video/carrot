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
        videoStats?: {
            yAvgMin?: number;
            yAvgMax?: number;
            satAvgMax?: number;
        };
        /** SSIM against an ffmpeg-filtered reference built from a fixture —
         * proves per-pixel agreement with an independent implementation. */
        ssimRef?: {
            fixture: string;
            vf: string;
            min: number;
        };
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
        burnCheck?: {
            crop: string;
            activeAt: number;
            minActive: number;
            inactiveAt?: number;
            maxInactive?: number;
        };
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
        quieterThanFixture?: {
            fixture: string;
            deltaDb: number;
        };
    };
}
export declare const DOC_CASES: DocCase[];
//# sourceMappingURL=doc-cases.d.ts.map