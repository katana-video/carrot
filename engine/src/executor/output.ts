/**
 * Output side — one muxer + one source per track for the whole job, configured
 * once (spans share them; per-span sink streams use closeSource:false and the
 * executor closes sources after the last span).
 *
 * Two source shapes per track, decided by plan.strategy [D1]:
 * - reencode: VideoSampleSource/AudioSampleSource with honest, device-aware
 *   codec negotiation (the E1 lesson: no AAC encoder in Linux Chrome).
 *   Preferences per container; first encodable wins; structured error else.
 * - copy: EncodedVideoPacketSource/EncodedAudioPacketSource carrying the
 *   source codec verbatim — no encoder involved, so no encodability check;
 *   container legality is re-verified here as a guard against planner drift.
 */

import {
  Output, BufferTarget, StreamTarget,
  VideoSampleSource, AudioSampleSource,
  EncodedVideoPacketSource, EncodedAudioPacketSource,
  TextSubtitleSource,
  QUALITY_LOW, QUALITY_MEDIUM, QUALITY_HIGH,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
  type VideoCodec, type AudioCodec, type Quality, type StreamTargetChunk,
} from 'mediabunny';
import type { CompiledPlan } from '../schema';
import { CONTAINERS, VIDEO_PREFS, AUDIO_PREFS, type ContainerId } from '../containers';

const QUALITIES: Record<string, Quality> = {
  low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH,
};

export interface JobOutput {
  output: Output;
  /** null when the job streams to a sink writable — bytes go to disk as
   *  they're muxed and no result blob exists (docs/streaming-output-plan.md). */
  target: BufferTarget | null;
  videoSource: VideoSampleSource | null;
  audioSource: AudioSampleSource | null;
  /** Set instead of the sample source when the lane's strategy is 'copy'. */
  videoPacketSource: EncodedVideoPacketSource | null;
  audioPacketSource: EncodedAudioPacketSource | null;
  /** Soft subtitle track [D8]; the executor pumps the VTT text once. */
  subtitleSource: TextSubtitleSource | null;
  videoCodec: VideoCodec | null;
  audioCodec: AudioCodec | null;
  mimeType: string;
}

export async function buildOutput(
  plan: CompiledPlan,
  /** Stream the muxed bytes here instead of buffering (positioned writes —
   *  FileSystemWritableFileStream accepts StreamTargetChunk natively, so a
   *  regular MP4 with a back-patched moov lands on disk; backpressure from
   *  the writable throttles the encoders). */
  sinkWritable?: WritableStream<StreamTargetChunk>,
): Promise<JobOutput> {
  const decl = plan.output;
  const container = decl.container as ContainerId;
  if (!CONTAINERS[container]) {
    throw new Error(`container '${decl.container}' has no muxer — image outputs need plan.still`);
  }
  const target = sinkWritable ? null : new BufferTarget();
  const output = new Output({
    format: CONTAINERS[container](),
    target: target ?? new StreamTarget(sinkWritable!, { chunked: true }),
  });

  let videoSource: VideoSampleSource | null = null;
  let videoPacketSource: EncodedVideoPacketSource | null = null;
  let videoCodec: VideoCodec | null = null;
  if (decl.video) {
    if (plan.strategy.video === 'copy') {
      const copy = plan.copy?.video;
      if (!copy) throw new Error('strategy.video is copy but plan.copy.video is missing');
      if (!(output.format.getSupportedVideoCodecs() as string[]).includes(copy.codec)) {
        throw new Error(`cannot stream-copy video codec '${copy.codec}' into ${container}`);
      }
      videoCodec = copy.codec as VideoCodec;
      videoPacketSource = new EncodedVideoPacketSource(videoCodec);
      output.addVideoTrack(videoPacketSource);
    } else {
      const prefs = decl.video.codec ? [decl.video.codec] : VIDEO_PREFS[container];
      if (!prefs) throw new Error(`container '${container}' does not accept video`);
      videoCodec = await getFirstEncodableVideoCodec(prefs, {
        width: plan.canvas.w, height: plan.canvas.h,
      });
      if (!videoCodec) throw new Error(`no encodable video codec among [${prefs.join(', ')}] on this device`);
      videoSource = new VideoSampleSource({
        codec: videoCodec,
        bitrate: decl.video.bitrate ?? QUALITIES[decl.video.quality ?? 'medium']!,
      });
      output.addVideoTrack(videoSource);
    }
  }

  let audioSource: AudioSampleSource | null = null;
  let audioPacketSource: EncodedAudioPacketSource | null = null;
  let audioCodec: AudioCodec | null = null;
  if (decl.audio && plan.audioFormat) {
    if (plan.strategy.audio === 'copy') {
      const copy = plan.copy?.audio;
      if (!copy) throw new Error('strategy.audio is copy but plan.copy.audio is missing');
      if (!(output.format.getSupportedAudioCodecs() as string[]).includes(copy.codec)) {
        throw new Error(`cannot stream-copy audio codec '${copy.codec}' into ${container}`);
      }
      audioCodec = copy.codec as AudioCodec;
      audioPacketSource = new EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(audioPacketSource);
    } else {
      const prefs = decl.audio.codec ? [decl.audio.codec] : AUDIO_PREFS[container];
      if (!prefs) throw new Error(`container '${container}' does not accept audio`);
      audioCodec = await getFirstEncodableAudioCodec(prefs, {
        numberOfChannels: plan.audioFormat.channels,
        sampleRate: plan.audioFormat.rate,
      });
      if (!audioCodec) throw new Error(`no encodable audio codec among [${prefs.join(', ')}] on this device`);
      audioSource = new AudioSampleSource(
        decl.audio.bitrate != null
          ? { codec: audioCodec, bitrate: decl.audio.bitrate }
          : { codec: audioCodec, bitrate: QUALITY_MEDIUM },
      );
      output.addAudioTrack(audioSource);
    }
  }

  let subtitleSource: TextSubtitleSource | null = null;
  if (decl.subtitles) {
    if (!(output.format.getSupportedSubtitleCodecs() as string[]).includes('webvtt')) {
      throw new Error(`container '${container}' cannot carry a webvtt subtitle track`);
    }
    subtitleSource = new TextSubtitleSource('webvtt');
    output.addSubtitleTrack(subtitleSource,
      decl.subtitles.language ? { languageCode: decl.subtitles.language } : undefined);
  }

  await output.start();
  return {
    output, target, videoSource, audioSource, videoPacketSource, audioPacketSource,
    subtitleSource, videoCodec, audioCodec, mimeType: output.format.mimeType,
  };
}
