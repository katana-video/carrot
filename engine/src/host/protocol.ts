/**
 * Worker-host wire protocol. The MAIN thread runs plan() (pure, fast, needed
 * for the confirmation UI); the WORKER runs execution AND all mediabunny
 * probing — everything that parses media bytes lives worker-side, so the
 * main bundle ships no mediabunny at all. Blobs cross the boundary by
 * structured clone. Deriver backends CANNOT cross the boundary (functions
 * don't clone): the worker entry composes them at build time
 * (createWorkerHost).
 */
import type { Backend, CompiledPipeline, CompiledPlan, MediaKind, PipelineStep } from '../schema';

export interface HostAsset { kind: MediaKind; blob: Blob; label?: string }

/** Read-only probe RPCs: facts for attach, deep probes for compile-time
 * probe events, the denoise-preview audio window. All resolve to plain
 * clonable data. */
export type ProbeRequest =
  | { type: 'probe'; id: number; op: 'facts'; blob: Blob }
  | { type: 'probe'; id: number; op: 'rawFacts'; blob: Blob }
  | { type: 'probe'; id: number; op: 'audioStats'; blob: Blob }
  | { type: 'probe'; id: number; op: 'decodeHealth'; blob: Blob }
  | { type: 'probe'; id: number; op: 'loudness'; blob: Blob }
  | { type: 'probe'; id: number; op: 'audioWindow48k'; blob: Blob; start: number; end: number };

export type HostRequest =
  | {
    type: 'run';
    id: number;
    /** Exactly one of plan (single render, the v0.1 surface) or pipeline. */
    plan?: CompiledPlan;
    pipeline?: CompiledPipeline;
    assets: Record<string, HostAsset>;
    backend?: Backend | 'auto';
    /** Stream the muxed deliverable to this file instead of returning a
     * blob (docs/streaming-output-plan.md). Handles structured-clone; the
     * FRONTEND acquires it (showSaveFilePicker — user gesture) and decides
     * when to offer disk output; the engine only consumes it. done.blob is
     * null on sink runs. v1: single muxed-container render deliverable only.
     * NEVER wrap a handle in a reactive proxy — postMessage rejects it. */
    sink?: FileSystemFileHandle;
  }
  | ProbeRequest
  | { type: 'cancel'; id: number };

export type HostResponse =
  | { type: 'probe-done'; id: number; result: unknown }
  | { type: 'progress'; id: number; spanIndex: number; spanCount: number; mediaTime: number; totalDuration: number }
  | { type: 'step'; id: number; stepIndex: number; stepCount: number; stepId: string; kind: PipelineStep['kind'] }
  | { type: 'model'; id: number; loaded: number; total: number }
  | { type: 'deriver-progress'; id: number; fraction: number }
  | {
    /** blob is null when the run streamed to a sink — the output is already
     * at its destination (read `handle.getFile()` back for previews). */
    type: 'done'; id: number; blob: Blob | null; videoCodec: string | null; audioCodec: string | null;
    /** All deliverables [G2 amendment], authored order; single-op runs carry
     * one entry (=== blob). Absent for plain plan runs and sink runs. */
    outputs?: { id: string; blob: Blob }[];
  }
  | { type: 'error'; id: number; name: string; message: string };
