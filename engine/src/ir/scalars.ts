/**
 * Symbolic scalar resolution [S1–S3] — the ONLY place symbols become numbers.
 * All resolution is deterministic; the document author never computes.
 */

import type { TimeScalar, SpaceScalar, Volume } from './document';

const parsePercent = (s: string): number | null => {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(s);
  return m ? Number(m[1]) / 100 : null;
};

/** Resolve a time scalar against a reference duration (seconds). */
export function resolveTime(v: TimeScalar, duration: number): number {
  if (typeof v === 'number') return v < 0 ? duration + v : v;
  if (v === 'start') return 0;
  if (v === 'end') return duration;
  const p = parsePercent(v);
  if (p === null) throw new Error(`unresolvable time scalar: ${String(v)}`);
  return duration * (p < 0 ? 1 + p : p);
}

/** Resolve a space scalar against a reference dimension (pixels). */
export function resolveSpace(v: SpaceScalar, dimension: number): number {
  if (typeof v === 'number') return v;
  const p = parsePercent(v);
  if (p === null) throw new Error(`unresolvable space scalar: ${String(v)}`);
  return dimension * p;
}

/** Resolve a volume to a linear gain [M1]. */
export function resolveVolume(v: Volume | undefined): number {
  if (v === undefined) return 1;
  if (typeof v === 'number') return v;
  const p = parsePercent(v);
  if (p === null) throw new Error(`unresolvable volume: ${String(v)}`);
  return p;
}

/** Resolve a range to [start, end) in source time; omit = whole source [S3]. */
export function resolveRange(
  range: { start?: TimeScalar | undefined; end?: TimeScalar | undefined } | undefined,
  duration: number,
): { start: number; end: number } {
  return {
    start: range?.start !== undefined ? resolveTime(range.start, duration) : 0,
    end: range?.end !== undefined ? resolveTime(range.end, duration) : duration,
  };
}
