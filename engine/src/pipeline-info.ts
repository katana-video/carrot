/**
 * Pure CompiledPipeline inspection — what a pipeline WILL do, without any
 * executor machinery. Split from executor/pipeline.ts so main-thread callers
 * (plan review UI, auto-run policy) can import these through the deferred
 * planner chunk without dragging the mediabunny execution chain along
 * (the codec-tables split, applied to pipeline metadata).
 */
import type { CompiledPipeline, CompiledPlan } from './schema';

export function planAssetRefs(plan: CompiledPlan): Set<string> {
  const refs = new Set<string>();
  for (const span of plan.spans) {
    for (const b of span.video?.bindings ?? []) refs.add(b.asset);
    for (const a of Object.values(span.video?.staticSlots ?? {})) refs.add(a);
    for (const c of Object.values(span.video?.captionSlots ?? {})) refs.add(c.asset);
    for (const b of span.audio?.bindings ?? []) refs.add(b.asset);
  }
  if (plan.copy?.video) refs.add(plan.copy.video.asset);
  if (plan.copy?.audio) refs.add(plan.copy.audio.asset);
  if (plan.output.subtitles) refs.add(plan.output.subtitles.asset);
  return refs;
}

/** Steps that transitively feed a deliverable; anything else is dead work. */
export function neededSteps(pipeline: CompiledPipeline): Set<string> {
  const deps = new Map<string, string[]>();
  for (const s of pipeline.steps) {
    deps.set(s.id, s.kind === 'render' || s.kind === 'transformImage'
      ? [...planAssetRefs(s.plan)]
      : s.kind === 'qr' ? [] : [s.source.split('.')[0]!]);
  }
  const needed = new Set<string>();
  const visit = (id: string) => {
    if (needed.has(id) || !deps.has(id)) return;
    needed.add(id);
    for (const d of deps.get(id)!) visit(d);
  };
  for (const id of pipeline.deliverables ?? [pipeline.deliver]) visit(id);
  return needed;
}

/** The model-backed capabilities a pipeline will actually exercise [G4] —
 * derivers on needed steps plus render kernels. The host maps these onto its
 * weights registry / cache state to annotate the plan (ready /
 * needs-preparation with sizes) BEFORE execution; nothing downloads at
 * compile time. */
export interface CapabilityRequirement {
  capability: 'transcribe' | 'translate' | 'removebg' | 'upscale' | 'denoise' | 'level' | 'enhance';
  params: Record<string, unknown>;
}

export function pipelineRequirements(pipeline: CompiledPipeline): CapabilityRequirement[] {
  const needed = neededSteps(pipeline);
  const reqs: CapabilityRequirement[] = [];
  for (const step of pipeline.steps) {
    if (!needed.has(step.id)) continue;
    if (step.kind === 'render' || step.kind === 'transformImage') {
      for (const k of step.plan.videoKernels ?? []) reqs.push({ capability: k.op, params: k.params });
      for (const k of step.plan.audioKernels ?? []) reqs.push({ capability: k.op, params: k.params });
    } else if (step.kind !== 'qr') { // qr is built-in: no weights, nothing to prepare
      reqs.push({ capability: step.kind, params: step.params });
    }
  }
  return reqs;
}

/**
 * True when every needed step finishes near-instantly with no progress story
 * to tell: pure generators (qr), GPU still composites (transformImage), and
 * single-frame renders — and nothing needs model weights. Frontends may
 * auto-run such pipelines instead of asking for a Start [I1]; anything with
 * a span loop (video/audio/gif encode) or a capability requirement keeps
 * the review + progress treatment.
 */
export function instantPipeline(pipeline: CompiledPipeline): boolean {
  if (pipelineRequirements(pipeline).length > 0) return false;
  const needed = neededSteps(pipeline);
  return pipeline.steps.every((step) =>
    !needed.has(step.id)
    || step.kind === 'qr'
    || step.kind === 'transformImage'
    || (step.kind === 'render' && step.plan.still !== undefined));
}
