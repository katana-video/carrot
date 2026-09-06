/**
 * Worker-side host runtime. A worker ENTRY file calls createWorkerHost(),
 * optionally supplying deriver backends and kernel registrations — that entry
 * is where an app composes the engine with its model runtimes (they cannot
 * cross postMessage). The bare engine entry (worker.ts) passes nothing:
 * single-render plans work, model-backed steps fail honestly.
 */
import type { AssetTable } from '../schema';
import { execute } from '../executor/execute';
import { measureLoudness } from '../loudness';
import { registerLevel } from '../executor/levelKernel';
import { executePipeline, type DeriverBackends, type PipelineResult } from '../executor/pipeline';
import { probe } from '../probe';
import { probeAudioStats, probeDecodeHealth } from '../probe-deep';
import { extractAudioWindow48k } from '../probe-audio-window';
import { factsFromProbe } from '../ir/facts';
import type { HostRequest, HostResponse, ProbeRequest } from './protocol';

export interface WorkerHostOptions {
  derivers?: DeriverBackends;
  /** Called once before the first run — the place to registerOp() kernels
   * lazily (kernels resolve from the registry at execute time either way). */
  init?: () => void | Promise<void>;
}

export function createWorkerHost(opts: WorkerHostOptions = {}): void {
  registerLevel(); // built-in audio kernel (pure JS, no weights) — see [H4]
  const aborters = new Map<number, AbortController>();
  const post = (m: HostResponse, transfer?: Transferable[]) =>
    (self as unknown as { postMessage(m: HostResponse, o?: { transfer: Transferable[] }): void })
      .postMessage(m, transfer ? { transfer } : undefined);
  let initialized: Promise<void> | null = null;

  self.onmessage = (e: MessageEvent<HostRequest>) => {
    const msg = e.data;
    if (msg.type === 'cancel') {
      aborters.get(msg.id)?.abort();
      return;
    }
    if (msg.type === 'probe') {
      void handleProbe(msg);
      return;
    }
    void run(msg);
  };

  // Probes never touch kernels or derivers — no init needed, safe before
  // any run. Errors return through the shared error response.
  async function handleProbe(msg: ProbeRequest): Promise<void> {
    try {
      if (msg.op === 'audioWindow48k') {
        const samples = await extractAudioWindow48k(msg.blob, msg.start, msg.end);
        post({ type: 'probe-done', id: msg.id, result: samples }, [samples.buffer as ArrayBuffer]);
        return;
      }
      const result = msg.op === 'facts' ? factsFromProbe(await probe(msg.blob))
        : msg.op === 'rawFacts' ? await probe(msg.blob)
          : msg.op === 'audioStats' ? await probeAudioStats(msg.blob)
          : msg.op === 'loudness' ? await measureLoudness(msg.blob)
            : await probeDecodeHealth(msg.blob);
      post({ type: 'probe-done', id: msg.id, result });
    } catch (err) {
      post({
        type: 'error', id: msg.id,
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function run(msg: Extract<HostRequest, { type: 'run' }>): Promise<void> {
    const controller = new AbortController();
    aborters.set(msg.id, controller);
    let lastProgress = 0;
    let lastModel = 0;
    let lastDeriver = 0;
    let sinkWritable: FileSystemWritableFileStream | null = null;
    try {
      if (msg.sink && !msg.pipeline) throw new Error('sink output requires a pipeline run');
      initialized ??= Promise.resolve(opts.init?.());
      await initialized;
      const assets: AssetTable = Object.fromEntries(
        Object.entries(msg.assets).map(([id, a]) => [id, { kind: a.kind, source: a.blob, ...(a.label ? { label: a.label } : {}) }]),
      );
      // Sink runs [docs/streaming-output-plan.md]: open the writable here so
      // failure paths can abort() it — an unclosed FileSystemWritableFileStream
      // leaves the browser's swap file behind (gotcha inherited from the
      // upscaler's resumable path, fixed rather than copied).
      sinkWritable = msg.sink ? await msg.sink.createWritable() : null;
      const shared = {
        backend: msg.backend ?? 'auto',
        signal: controller.signal,
        onProgress: (p: { spanIndex: number; spanCount: number; mediaTime: number; totalDuration: number }) => {
          const now = performance.now();
          if (now - lastProgress < 100 && p.mediaTime < p.totalDuration) return;
          lastProgress = now;
          post({ type: 'progress', id: msg.id, ...p });
        },
      };
      const result = msg.pipeline
        ? await executePipeline(msg.pipeline, assets, {
          ...shared,
          ...(sinkWritable ? { sink: sinkWritable } : {}),
          ...(opts.derivers ? { derivers: opts.derivers } : {}),
          onStep: (p) => post({ type: 'step', id: msg.id, ...p }),
          onModelProgress: (loaded, total) => {
            const now = performance.now();
            if (now - lastModel < 200 && loaded < total) return;
            lastModel = now;
            post({ type: 'model', id: msg.id, loaded, total });
          },
          onDeriverProgress: (fraction) => {
            const now = performance.now();
            if (now - lastDeriver < 150 && fraction < 1) return;
            lastDeriver = now;
            post({ type: 'deriver-progress', id: msg.id, fraction });
          },
        })
        : await execute(msg.plan!, assets, shared);
      // The StreamTarget closes the writable on Output.finalize(); nothing
      // left to close here on success.
      const outputs = msg.pipeline ? (result as PipelineResult).outputs : undefined;
      post({
        type: 'done', id: msg.id, blob: result.blob,
        videoCodec: result.videoCodec, audioCodec: result.audioCodec,
        ...(outputs ? { outputs } : {}),
      });
    } catch (err) {
      // best-effort: discard the partial file's swap so the failed run
      // leaves nothing behind (abort() on an already-closed stream throws —
      // ignore)
      try { await sinkWritable?.abort(); } catch { /* already closed */ }
      post({
        type: 'error', id: msg.id,
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      aborters.delete(msg.id);
    }
  }
}
