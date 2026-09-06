/**
 * Named looks [E7] — batch-2 of the filters arc (docs/filters-gpu-plan.md).
 * A look is an ENGINE-OWNED recipe over the batch-1 primitives: the model
 * names a style, deterministic code decides what it means — same principle
 * as everywhere else (closed vocabulary, no model-authored parameters
 * unless the user asks for specifics, in which case primitives compose).
 *
 * `amount` (0..1, default 1) scales each recipe's departure from neutral, so
 * "a subtle vintage feel" is one field, not a re-derived recipe.
 */

import type { Effect } from './document';

/** lerp toward neutral: neutral + (value − neutral) · amount */
const k = (neutral: number, value: number, a: number): number =>
  neutral + (value - neutral) * a;

export const LOOKS = {
  /** Warm faded 70s-film feel: warmth + partial sepia + grain + vignette. */
  vintage: (a: number): Effect[] => [
    { type: 'temperature', amount: k(0, 0.25, a) },
    { type: 'sepia', amount: k(0, 0.35, a) },
    { type: 'contrast', amount: k(1, 1.08, a) },
    { type: 'grain', amount: k(0, 0.3, a) },
    { type: 'vignette', strength: k(0, 0.45, a) },
  ],
  /** High-contrast black & white with crushed blacks. */
  noir: (a: number): Effect[] => [
    { type: 'grayscale', amount: a },
    { type: 'levels', black: k(0, 0.06, a) },
    { type: 'contrast', amount: k(1, 1.25, a) },
    { type: 'vignette', strength: k(0, 0.5, a) },
  ],
  /** Worn-tape look: soft, desaturated, noisy. */
  vhs: (a: number): Effect[] => [
    { type: 'blur', radius: Math.max(0.5, k(0.5, 1.2, a)) },
    { type: 'saturation', amount: k(1, 0.82, a) },
    { type: 'contrast', amount: k(1, 0.94, a) },
    { type: 'grain', amount: k(0, 0.45, a) },
  ],
  /** Teal–orange-leaning grade with gentle vignette. */
  cinematic: (a: number): Effect[] => [
    { type: 'temperature', amount: k(0, 0.15, a), tint: k(0, -0.05, a) },
    { type: 'contrast', amount: k(1, 1.12, a) },
    { type: 'saturation', amount: k(1, 1.1, a) },
    { type: 'vignette', strength: k(0, 0.35, a) },
  ],
  /** Punchy social-media pop. */
  vivid: (a: number): Effect[] => [
    { type: 'vibrance', amount: k(0, 0.5, a) },
    { type: 'contrast', amount: k(1, 1.1, a) },
    { type: 'sharpen', amount: k(0, 0.6, a) },
  ],
  /** Soft-focus glow. */
  dreamy: (a: number): Effect[] => [
    { type: 'blur', radius: Math.max(0.5, k(0.5, 1.6, a)) },
    { type: 'brightness', amount: k(1, 1.08, a) },
    { type: 'saturation', amount: k(1, 0.9, a) },
    { type: 'vignette', strength: k(0, 0.3, a) },
  ],
  /** Washed, low-contrast matte. */
  faded: (a: number): Effect[] => [
    { type: 'contrast', amount: k(1, 0.85, a) },
    { type: 'brightness', amount: k(1, 1.05, a) },
    { type: 'saturation', amount: k(1, 0.8, a) },
    { type: 'temperature', amount: k(0, 0.1, a) },
  ],
  /** Warm bright sun-kissed grade. */
  summer: (a: number): Effect[] => [
    { type: 'temperature', amount: k(0, 0.3, a) },
    { type: 'vibrance', amount: k(0, 0.3, a) },
    { type: 'brightness', amount: k(1, 1.05, a) },
  ],
  /** Cool desaturated cold-weather grade. */
  winter: (a: number): Effect[] => [
    { type: 'temperature', amount: k(0, -0.3, a) },
    { type: 'saturation', amount: k(1, 0.9, a) },
    { type: 'brightness', amount: k(1, 1.02, a) },
  ],
} satisfies Record<string, (a: number) => Effect[]>;

export type LookName = keyof typeof LOOKS;

/** Expand look effects into their primitive recipes; primitives pass through.
 * Recipes contain only primitives, so this never recurses. */
export function expandLooks(effects: Effect[]): Effect[] {
  return effects.flatMap((fx) =>
    fx.type === 'look' ? LOOKS[fx.name]((fx.amount ?? 1)) : [fx]);
}
