/**
 * The executor — CompiledPlan + assets in, output blob out.
 * `for (const span of spans) await span's lanes` is the whole control flow
 * (E3's proven shape, plan-driven). Completion is structural; cancellation
 * propagates through stream mechanics into Mediabunny teardown.
 */

import type { AssetTable, Backend, CompiledPlan, Sec } from '../schema';
import { AssetIO } from './assets';
import { buildOutput } from './output';
import { runVideoLane } from './videoLane';
import { runAudioLane } from './audioLane';
import { runCopyLane } from './copyLane';
import { runStill } from './still';
import { conformVideoSink } from './conform';
import { GifEncoder } from './gif';
import { createAudioKernel, createVideoKernel, kernelAudioSink, kernelVideoSink, resolveBackend } from './kernels';

export interface ExecuteOptions {
  backend?: Backend | 'auto';
  signal?: AbortSignal;
  onProgress?: (p: ExecuteProgress) => void;
  /** Stream muxed output here instead of buffering; result.blob is null
   *  (bytes are already at their destination). docs/streaming-output-plan.md */
  sink?: WritableStream<import('mediabunny').StreamTargetChunk>;
}

export interface ExecuteProgress {
  spanIndex: number;
  spanCount: number;
  /** Furthest output media time written, seconds. */
  mediaTime: Sec;
  /** Total output duration (last span's end). */
  totalDuration: Sec;
}

export interface ExecuteResult {
  /** null when ExecuteOptions.sink was used — no in-memory result exists. */
  blob: Blob | null;
  videoCodec: string | null;
  audioCodec: string | null;
  spanCount: number;
}

export async function execute(
  plan: CompiledPlan,
  assets: AssetTable,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const signal = opts.signal ?? new AbortController().signal;
  const backend = opts.backend ?? 'auto';
  const spans = plan.spans;
  if (spans.length === 0) throw new Error('plan has no spans');
  const totalDuration = spans[spans.length - 1]!.end;

  const io = await AssetIO.open(assets);

  // whole-output model kernels [U3, H3] — resolved from the host registry
  const videoKernel = plan.videoKernels?.length
    ? await createVideoKernel(plan, resolveBackend(backend)) : null;
  /** Composite runs at the pre-kernel canvas when a kernel intervenes. */
  const laneCanvas = plan.compositeCanvas ?? plan.canvas;

  // single-frame extraction [D7]: no muxer, no span loop
  if (plan.still) {
    const blob = await runStill(plan, io, backend, videoKernel);
    opts.onProgress?.({ spanIndex: 0, spanCount: 1, mediaTime: totalDuration, totalDuration });
    return { blob, videoCodec: null, audioCodec: null, spanCount: 1 };
  }

  // animated gif [D9]: the normal span-loop render path, sunk into the
  // custom GIF encoder instead of a muxer (video only)
  if (plan.output.container === 'gif') {
    const enc = new GifEncoder(plan.canvas.w, plan.canvas.h);
    // conform sits closest to the encoder [D5]; the kernel (if any) wraps it
    const gifConform = plan.fps ? conformVideoSink(enc, plan.fps) : null;
    const gifBase = gifConform ?? enc;
    const gifSink = videoKernel ? kernelVideoSink(gifBase, videoKernel) : gifBase;
    let gifTime = 0;
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
      opts.onProgress?.({ spanIndex: i, spanCount: spans.length, mediaTime: gifTime, totalDuration });
      if (span.video) {
        await runVideoLane(span, laneCanvas, {
          io, videoSource: gifSink, backend, signal,
          onMediaTime: (t) => { gifTime = Math.max(gifTime, t); },
        });
      }
    }
    await gifConform?.flush(totalDuration);
    return { blob: enc.finish(), videoCodec: null, audioCodec: null, spanCount: spans.length };
  }

  const job = await buildOutput(plan, opts.sink);

  const audioKernel = plan.audioKernels?.length && plan.audioFormat && job.audioSource
    ? await createAudioKernel(plan, plan.audioFormat) : null;
  const audioSink = audioKernel && job.audioSource && plan.audioFormat
    ? kernelAudioSink(job.audioSource, audioKernel, plan.audioFormat) : null;
  // conform sits closest to the encoder [D5]; the kernel (if any) wraps it
  const conform = plan.fps && job.videoSource ? conformVideoSink(job.videoSource, plan.fps) : null;
  const encSink = conform ?? job.videoSource;
  const videoSink = videoKernel && encSink
    ? kernelVideoSink(encSink, videoKernel) : encSink;

  // Progress = the SLOWEST contributing lane. Copy pumps sprint ahead to the
  // muxer's interleave cap (a video copy hits ~3/4 in a second while the
  // audio kernel crawls) — the honest bar is the furthest time EVERY lane
  // has written.
  const hasVideoLane = plan.strategy.video === 'copy' || spans.some((s) => !!s.video && !!videoSink);
  const hasAudioLane = plan.strategy.audio === 'copy'
    || spans.some((s) => !!s.audio && !!job.audioSource && !!plan.audioFormat);
  let videoTime = 0;
  let audioTime = 0;
  let mediaTime = 0;
  const progress = (spanIndex: number) => {
    const parts: number[] = [];
    if (hasVideoLane) parts.push(videoTime);
    if (hasAudioLane) parts.push(audioTime);
    mediaTime = parts.length ? Math.min(...parts) : mediaTime;
    opts.onProgress?.({ spanIndex, spanCount: spans.length, mediaTime, totalDuration });
  };

  try {
    // Copy lanes are whole-job pumps [D1] — they run once, concurrently with
    // the re-encoding lanes' span loop (the muxer interleaves both tracks).
    const copyPumps: Promise<void>[] = [];
    if (plan.strategy.video === 'copy' && job.videoPacketSource) {
      const decl = plan.copy?.video;
      if (!decl) throw new Error('strategy.video is copy but plan.copy.video is missing');
      copyPumps.push(runCopyLane(decl, 'video', job.videoPacketSource, {
        io, signal,
        onMediaTime: (t) => { videoTime = Math.max(videoTime, t); progress(0); },
      }));
    }
    if (plan.strategy.audio === 'copy' && job.audioPacketSource) {
      const decl = plan.copy?.audio;
      if (!decl) throw new Error('strategy.audio is copy but plan.copy.audio is missing');
      copyPumps.push(runCopyLane(decl, 'audio', job.audioPacketSource, {
        io, signal,
        onMediaTime: (t) => { audioTime = Math.max(audioTime, t); progress(0); },
      }));
    }

    // Soft subtitles [D8]: mux the whole VTT once; the muxer interleaves.
    if (job.subtitleSource && plan.output.subtitles) {
      const asset = io.get(plan.output.subtitles.asset);
      if (asset.text == null) throw new Error(`asset '${asset.label}' is not timed-text`);
      copyPumps.push(job.subtitleSource.add(asset.text));
    }

    const spanLoop = async () => {
      for (let i = 0; i < spans.length; i++) {
        const span = spans[i]!;
        if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
        progress(i);
        await Promise.all([
          span.video && videoSink
            ? runVideoLane(span, laneCanvas, {
                io,
                videoSource: videoSink,
                backend,
                signal,
                onMediaTime: (t) => { videoTime = Math.max(videoTime, t); progress(i); },
              })
            : Promise.resolve(),
          span.audio && job.audioSource && plan.audioFormat
            ? runAudioLane(span, {
                io,
                // the kernel sink interposes on add(); lanes never close it
                audioSource: (audioSink ?? job.audioSource) as typeof job.audioSource & object,
                rate: plan.audioFormat.rate,
                channels: plan.audioFormat.channels,
                signal,
                onMediaTime: (t) => { audioTime = Math.max(audioTime, t); progress(i); },
              })
            : Promise.resolve(),
        ]);
      }
    };
    await Promise.all([spanLoop(), ...copyPumps]);

    await audioSink?.flush();
    await conform?.flush(totalDuration);
    job.videoSource?.close();
    job.audioSource?.close();
    job.videoPacketSource?.close();
    job.audioPacketSource?.close();
    job.subtitleSource?.close();
    await job.output.finalize();

    let blob: Blob | null = null;
    if (job.target) {
      const buffer = job.target.buffer;
      if (!buffer) throw new Error('output produced no buffer');
      blob = new Blob([buffer], { type: job.mimeType });
    }
    return {
      blob,
      videoCodec: job.videoCodec,
      audioCodec: job.audioCodec,
      spanCount: spans.length,
    };
  } catch (err) {
    // Sink runs: abort the writable BEFORE output.cancel() — cancel closes
    // the target's stream writer, and close() on a FileSystemWritableFileStream
    // MATERIALIZES the partial file at the user's chosen path. Abort discards
    // the swap instead.
    if (opts.sink) { try { await opts.sink.abort(); } catch { /* already errored */ } }
    try { await job.output.cancel(); } catch { /* best-effort teardown */ }
    throw err;
  }
}
