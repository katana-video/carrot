/**
 * Typed main-thread client for the engine worker. Takes the Worker instance
 * by injection so bundlers own worker instantiation (Vite: `?worker` import).
 */
import type { Backend, CompiledPipeline } from '../schema';
import type { CompiledPlan } from '../schema';
import type { AssetFacts } from '../ir/facts';
import type { MediaFacts } from '../probe';
import type { AudioStatsFacts, DecodeHealthFacts } from '../probe-deep';
import type { LoudnessFacts } from '../loudness';
import type { HostAsset, HostRequest, HostResponse } from './protocol';

export interface EngineProgress { spanIndex: number; spanCount: number; mediaTime: number; totalDuration: number }
export interface EngineStep { stepIndex: number; stepCount: number; stepId: string; kind: string }
export interface EngineModelProgress { loaded: number; total: number }
export interface EngineRunResult {
  /** null when the run streamed to a sink (EngineRunOptions.sink) — the file
   *  is already at its destination; `sink.getFile()` reads it back. */
  blob: Blob | null;
  videoCodec: string | null; audioCodec: string | null;
  /** All deliverables [G2 amendment], authored order (pipeline runs only). */
  outputs?: { id: string; blob: Blob }[];
}

export interface EngineRunOptions {
  backend?: Backend | 'auto';
  signal?: AbortSignal;
  onProgress?: (p: EngineProgress) => void;
  onStep?: (p: EngineStep) => void;
  onModelProgress?: (p: EngineModelProgress) => void;
  /** Deriver inference progress 0..1 for the current step (see onStep). */
  onDeriverProgress?: (fraction: number) => void;
  /** Stream the muxed deliverable to this file instead of returning a blob.
   *  The FRONTEND acquires the handle (showSaveFilePicker, user gesture) and
   *  owns the when-to-offer policy — docs/streaming-output-plan.md. */
  sink?: FileSystemFileHandle;
}

export class EngineWorkerError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

interface Pending {
  resolve: (r: EngineRunResult) => void;
  reject: (e: Error) => void;
  onProgress?: ((p: EngineProgress) => void) | undefined;
  onStep?: ((p: EngineStep) => void) | undefined;
  onModelProgress?: ((p: EngineModelProgress) => void) | undefined;
  onDeriverProgress?: ((fraction: number) => void) | undefined;
}

interface ProbePending { resolve: (r: unknown) => void; reject: (e: Error) => void }

export class EngineWorkerClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private probePending = new Map<number, ProbePending>();

  constructor(private worker: Worker) {
    worker.onmessage = (e: MessageEvent<HostResponse>) => {
      const msg = e.data;
      if (msg.type === 'probe-done') {
        const pp = this.probePending.get(msg.id);
        this.probePending.delete(msg.id);
        pp?.resolve(msg.result);
        return;
      }
      if (msg.type === 'error' && this.probePending.has(msg.id)) {
        const pp = this.probePending.get(msg.id)!;
        this.probePending.delete(msg.id);
        pp.reject(new EngineWorkerError(msg.name, msg.message));
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg);
      } else if (msg.type === 'step') {
        p.onStep?.(msg);
      } else if (msg.type === 'model') {
        p.onModelProgress?.(msg);
      } else if (msg.type === 'deriver-progress') {
        p.onDeriverProgress?.(msg.fraction);
      } else if (msg.type === 'done') {
        this.pending.delete(msg.id);
        p.resolve({
          blob: msg.blob, videoCodec: msg.videoCodec, audioCodec: msg.audioCodec,
          ...(msg.outputs ? { outputs: msg.outputs } : {}),
        });
      } else {
        this.pending.delete(msg.id);
        p.reject(new EngineWorkerError(msg.name, msg.message));
      }
    };
    worker.onerror = (e) => {
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new EngineWorkerError('WorkerError', e.message || 'engine worker crashed'));
      }
      for (const [id, p] of this.probePending) {
        this.probePending.delete(id);
        p.reject(new EngineWorkerError('WorkerError', e.message || 'engine worker crashed'));
      }
    };
  }

  /** Static facts for an attachment (worker-side mediabunny probe). */
  probeFacts(blob: Blob): Promise<AssetFacts> {
    return this.probeDispatch<AssetFacts>({ op: 'facts', blob });
  }

  /** The UNREDUCED probe — container, full track list, per-track
   *  decodability. Diagnostics-grade detail (device debugging). */
  probeRawFacts(blob: Blob): Promise<MediaFacts> {
    return this.probeDispatch<MediaFacts>({ op: 'rawFacts', blob });
  }

  probeAudioStats(blob: Blob): Promise<AudioStatsFacts> {
    return this.probeDispatch<AudioStatsFacts>({ op: 'audioStats', blob });
  }

  probeDecodeHealth(blob: Blob): Promise<DecodeHealthFacts> {
    return this.probeDispatch<DecodeHealthFacts>({ op: 'decodeHealth', blob });
  }

  /** Integrated loudness (BS.1770) + sample peak — the leveling input. */
  probeLoudness(blob: Blob): Promise<LoudnessFacts> {
    return this.probeDispatch<LoudnessFacts>({ op: 'loudness', blob });
  }

  /** [start,end] of the source as 48 kHz mono f32 (denoise preview). */
  extractAudioWindow48k(blob: Blob, start: number, end: number): Promise<Float32Array> {
    return this.probeDispatch<Float32Array>({ op: 'audioWindow48k', blob, start, end });
  }

  private probeDispatch<T>(req:
    | { op: 'facts' | 'rawFacts' | 'audioStats' | 'decodeHealth' | 'loudness'; blob: Blob }
    | { op: 'audioWindow48k'; blob: Blob; start: number; end: number }): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.probePending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.worker.postMessage({ type: 'probe', id, ...req } as HostRequest);
    });
  }

  run(plan: CompiledPlan, assets: Record<string, HostAsset>, opts: EngineRunOptions = {}): Promise<EngineRunResult> {
    return this.dispatch({ plan }, assets, opts);
  }

  runPipeline(pipeline: CompiledPipeline, assets: Record<string, HostAsset>, opts: EngineRunOptions = {}): Promise<EngineRunResult> {
    return this.dispatch({ pipeline }, assets, opts);
  }

  private dispatch(
    job: { plan?: CompiledPlan; pipeline?: CompiledPipeline },
    assets: Record<string, HostAsset>,
    opts: EngineRunOptions,
  ): Promise<EngineRunResult> {
    const id = this.nextId++;
    return new Promise<EngineRunResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve, reject,
        onProgress: opts.onProgress, onStep: opts.onStep,
        onModelProgress: opts.onModelProgress, onDeriverProgress: opts.onDeriverProgress,
      });
      const request: HostRequest = {
        type: 'run', id, ...job, assets,
        ...(opts.backend ? { backend: opts.backend } : {}),
        ...(opts.sink ? { sink: opts.sink } : {}),
      };
      this.worker.postMessage(request);
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.has(id)) return;
        this.worker.postMessage({ type: 'cancel', id } satisfies HostRequest);
        this.pending.delete(id);
        reject(new DOMException('The render was cancelled.', 'AbortError'));
      }, { once: true });
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new EngineWorkerError('Terminated', 'engine worker terminated'));
    }
    for (const [id, p] of this.probePending) {
      this.probePending.delete(id);
      p.reject(new EngineWorkerError('Terminated', 'engine worker terminated'));
    }
  }
}
