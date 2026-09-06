/**
 * executePipeline() — CompiledPipeline + assets in, deliverable blob out [G1].
 *
 * Deriver steps run injected backends (the engine core carries no model
 * runtimes — hosts supply transcribe/translate/removebg implementations) and
 * publish their artifacts as synthetic assets: timed-text artifacts become
 * VTT blobs, image artifacts image blobs — so a downstream render's AssetIO
 * consumes them exactly like user assets [P2a].
 *
 * Only steps that transitively feed the deliverable execute; anything else is
 * dead work by construction (no operation type consumes a render's output).
 */

import type { AssetTable, CompiledPipeline, CompiledPlan, DeriverStep, PipelineStep } from '../schema';
import { execute, type ExecuteOptions, type ExecuteResult } from './execute';
import { parseVtt, type Cue } from './vtt';
import { cuesToSrt, cuesToVtt } from './timedtext';
// planAssetRefs / neededSteps / pipelineRequirements live in ../pipeline-info
// (lean, type-only imports) so UI policy code can use them without dragging
// this module's execution chain; the executor's step-pruning shares them.
import { neededSteps, planAssetRefs } from '../pipeline-info';

export interface DeriverCtx {
  signal: AbortSignal;
  /** Model download/load progress (bytes) — feeds the weights UI [G4]. */
  onModelProgress?: (loaded: number, total: number) => void;
  /** Inference progress for the CURRENT step, 0..1 — the deriver twin of the
   * render lane's media-time progress. Backends report what they honestly
   * know (whisper: audio seconds decoded; translate: batches done). */
  onProgress?: (fraction: number) => void;
}

export interface DeriverBackends {
  transcribe?(source: Blob, params: { model: string; language?: string }, ctx: DeriverCtx): Promise<Cue[]>;
  translate?(cues: Cue[], params: { to: string; from?: string }, ctx: DeriverCtx): Promise<Cue[]>;
  removebg?(source: Blob, params: Record<string, unknown>, ctx: DeriverCtx): Promise<Blob>;
}

export interface PipelineProgress {
  stepIndex: number;
  stepCount: number;
  stepId: string;
  kind: PipelineStep['kind'];
}

export interface ExecutePipelineOptions extends ExecuteOptions {
  derivers?: DeriverBackends;
  onStep?: (p: PipelineProgress) => void;
  onModelProgress?: DeriverCtx['onModelProgress'];
  /** Deriver inference progress (0..1) for the step named in the last onStep. */
  onDeriverProgress?: (fraction: number) => void;
  /** Test seam: replaces execute() for render steps. */
  renderExec?: (plan: CompiledPlan, assets: AssetTable, opts: ExecuteOptions) => Promise<ExecuteResult>;
}

/** Asset/artifact ids a compiled render plan references. */

const MIME: Record<DeriverStep['format'], string> = {
  vtt: 'text/vtt', srt: 'application/x-subrip', png: 'image/png', jpeg: 'image/jpeg',
};

/** [G3] jpeg has no alpha: composite the RGBA artifact over white. */
async function toJpeg(png: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(png);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

/** One deliverable of a multi-output pipeline [G2 amendment]. */
export interface PipelineOutput { id: string; blob: Blob }

/** ExecuteResult of the PRIMARY deliverable + every sink op's blob. */
export interface PipelineResult extends ExecuteResult { outputs: PipelineOutput[] }

export async function executePipeline(
  pipeline: CompiledPipeline,
  assets: AssetTable,
  opts: ExecutePipelineOptions = {},
): Promise<PipelineResult> {
  const signal = opts.signal ?? new AbortController().signal;
  const derivers = opts.derivers ?? {};
  const exec = opts.renderExec ?? execute;

  // Sink restriction [v1, docs/streaming-output-plan.md]: streaming output is
  // legal only when the pipeline's single deliverable is a muxed-container
  // render. The sink writable reaches exactly that step; every other render/
  // transformImage keeps the buffer path.
  const deliverIds = pipeline.deliverables ?? [pipeline.deliver];
  let sinkTargetId: string | null = null;
  if (opts.sink) {
    const target = deliverIds.length === 1
      ? pipeline.steps.find((s) => s.id === deliverIds[0]) : undefined;
    if (!target || target.kind !== 'render' || target.plan.still
      || target.plan.output.container === 'gif') {
      throw new Error('sink output requires a single muxed-container render deliverable');
    }
    sinkTargetId = target.id;
  }
  const optsSansSink: ExecutePipelineOptions = { ...opts };
  delete optsSansSink.sink;

  const table: AssetTable = { ...assets };
  const cueTable = new Map<string, Cue[]>();
  const needed = neededSteps(pipeline);
  const steps = pipeline.steps.filter((s) => needed.has(s.id));
  const ctx: DeriverCtx = {
    signal,
    ...(opts.onModelProgress ? { onModelProgress: opts.onModelProgress } : {}),
    ...(opts.onDeriverProgress ? { onProgress: opts.onDeriverProgress } : {}),
  };

  const sourceBlob = (id: string): Blob => {
    const decl = table[id.split('.')[0]!];
    if (!decl) throw new Error(`pipeline source '${id}' is not in the asset table`);
    return decl.source;
  };
  const sourceCues = async (id: string): Promise<Cue[]> => {
    const base = id.split('.')[0]!;
    const cached = cueTable.get(base);
    if (cached) return cached;
    return parseVtt(await sourceBlob(base).text());
  };

  const rendered = new Map<string, ExecuteResult>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (signal.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    opts.onStep?.({ stepIndex: i, stepCount: steps.length, stepId: step.id, kind: step.kind });

    if (step.kind === 'render') {
      rendered.set(step.id, await exec(step.plan, table, step.id === sinkTargetId ? opts : optsSansSink));
      continue;
    }

    if (step.kind === 'transformImage') {
      // the plan is a still render of the source image (effects folded in);
      // its encoded frame IS the artifact — publish it like any deriver's
      const r = await exec(step.plan, table, optsSansSink);
      // no sink was passed, so the still rendered to a buffer
      table[step.id] = { kind: 'image', source: r.blob!, label: step.id };
      rendered.set(step.id, r);
      continue;
    }

    if (step.kind === 'qr') {
      // pure generator, executor-owned: the encoder rides in its own chunk
      // (dynamic import) so no entry bundle ever carries it
      const { encodeQr, qrPngBlob } = await import('../qr');
      const blob = await qrPngBlob(encodeQr(step.params.text, step.params.ec), step.params.size);
      table[step.id] = { kind: 'image', source: blob, label: step.id };
      continue;
    }

    if (step.kind === 'transcribe') {
      const fn = derivers.transcribe;
      if (!fn) throw new Error("deriver 'transcribe' is not available on this host");
      const cues = await fn(sourceBlob(step.source), step.params as { model: string; language?: string }, ctx);
      cueTable.set(step.id, cues);
      table[step.id] = { kind: 'timed-text', source: new Blob([cuesToVtt(cues)], { type: 'text/vtt' }), label: step.id };
    } else if (step.kind === 'translate') {
      const fn = derivers.translate;
      if (!fn) throw new Error("deriver 'translate' is not available on this host");
      const out = await fn(await sourceCues(step.source), step.params as { to: string; from?: string }, ctx);
      // [L2] enforced engine-side: translated cues carry no word timings
      const cues = out.map((c) => ({ ...c, words: [], wordTiming: false }));
      cueTable.set(step.id, cues);
      table[step.id] = { kind: 'timed-text', source: new Blob([cuesToVtt(cues)], { type: 'text/vtt' }), label: step.id };
    } else {
      const fn = derivers.removebg;
      if (!fn) throw new Error("deriver 'removebg' is not available on this host");
      const blob = await fn(sourceBlob(step.source), step.params, ctx);
      table[step.id] = { kind: 'image', source: blob, label: step.id };
    }
  }

  // Deliverables [G2 amendment]: every sink op's blob, in authored order.
  // Render/transformImage steps deliver their encoded output directly;
  // deriver-terminal sinks serialize at the edge [G3].
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const outputs: PipelineOutput[] = [];
  for (const id of pipeline.deliverables ?? [pipeline.deliver]) {
    const step = stepById.get(id);
    if (!step) continue;
    if (step.kind === 'render' || step.kind === 'transformImage') {
      const r = rendered.get(id);
      if (r?.blob) outputs.push({ id, blob: r.blob }); // sink renders have no blob
    } else if (step.kind === 'removebg' || step.kind === 'qr') {
      const artifact = table[id]!.source;
      outputs.push({ id, blob: step.format === 'jpeg' ? await toJpeg(artifact) : artifact });
    } else {
      const cues = cueTable.get(id)!;
      const text = step.format === 'srt' ? cuesToSrt(cues) : cuesToVtt(cues);
      outputs.push({ id, blob: new Blob([text], { type: MIME[step.format] }) });
    }
  }

  // Sink runs deliver zero blobs — the file is already at its destination;
  // report the render's metadata with blob: null.
  if (sinkTargetId) {
    const meta = rendered.get(sinkTargetId);
    return {
      blob: null,
      videoCodec: meta?.videoCodec ?? null,
      audioCodec: meta?.audioCodec ?? null,
      spanCount: meta?.spanCount ?? 0,
      outputs,
    };
  }

  const primary = outputs.find((o) => o.id === pipeline.deliver) ?? outputs[outputs.length - 1];
  if (!primary) throw new Error('pipeline produced no deliverable');
  const meta = rendered.get(primary.id);
  return {
    blob: primary.blob,
    videoCodec: meta?.videoCodec ?? null,
    audioCodec: meta?.audioCodec ?? null,
    spanCount: meta?.spanCount ?? 0,
    outputs,
  };
}
