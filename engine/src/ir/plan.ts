/**
 * plan() / preflight() — the public planner entry points.
 * preflight IS the planner stopped before returning the plan [spec §12; the
 * no-drift rule]: both run normalize → lower on the same code path.
 */

import type { CompiledPipeline, CompiledPlan } from '../schema';
import type { IrDocument } from './document';
import type { IrError } from './errors';
import type { FactsTable } from './facts';
import { lower } from './lower';
import { normalize } from './normalize';

export interface PlanResult {
  /** The deliverable render's CompiledPlan — populated when the last authored
   * operation is a render (the single-render back-compat surface). */
  plan: CompiledPlan | null;
  /** The full operation pipeline [G1] — always populated on success. */
  pipeline: CompiledPipeline | null;
  /** The normalized (canonical) document — equality/caching operate on this. */
  normalized: IrDocument | null;
  errors: IrError[];
}

export function plan(input: unknown, facts: FactsTable): PlanResult {
  const n = normalize(input);
  if (!n.doc || n.errors.length) return { plan: null, pipeline: null, normalized: n.doc, errors: n.errors };
  const l = lower(n.doc, facts, n.topoOrder);
  return { plan: l.plan, pipeline: l.pipeline, normalized: n.doc, errors: l.errors };
}

export interface PreflightResult {
  ok: boolean;
  errors: IrError[];
}

export function preflight(input: unknown, facts: FactsTable): PreflightResult {
  const r = plan(input, facts);
  return { ok: r.pipeline !== null && r.errors.length === 0, errors: r.errors };
}
