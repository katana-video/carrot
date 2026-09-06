// Pass planner + shader codegen (render/filters.ts) — pure, Node-runnable.
// GPU-truth (the passes actually rendering, cross-backend equivalence) lives
// in experiments/e5-filters + e5-smoke.mjs.

import { describe, expect, it } from 'vitest';
import {
  blurTaps, passFragmentGlsl, passModuleWgsl, planFilterPasses,
} from '../src/render/filters';
import type { FilterStep } from '../src/schema';

const cm = (k: number): FilterStep => ({
  op: 'colorMatrix',
  matrix: [k, 0, 0, 0, k, 0, 0, 0, k],
  offset: [0, 0, 0],
});

describe('planFilterPasses', () => {
  it('collapses consecutive pointwise steps into one pass', () => {
    const passes = planFilterPasses([cm(0.5), cm(2)]);
    expect(passes).toHaveLength(1);
    expect(passes[0]).toMatchObject({ kind: 'pointwise' });
    expect((passes[0] as { steps: unknown[] }).steps).toHaveLength(2);
  });

  it('splits blur into two separable passes and breaks pointwise runs', () => {
    const passes = planFilterPasses([cm(1), { op: 'blur', radius: 4 }, cm(1)]);
    expect(passes.map((p) => p.kind)).toEqual(['pointwise', 'blur', 'blur', 'pointwise']);
    expect(passes[1]).toMatchObject({ axis: 'x', radius: 4 });
    expect(passes[2]).toMatchObject({ axis: 'y', radius: 4 });
  });

  it('prepends an extraction copy when the chain starts non-pointwise', () => {
    const passes = planFilterPasses([{ op: 'pixelate', size: 8 }]);
    expect(passes.map((p) => p.kind)).toEqual(['pointwise', 'pixelate']);
    expect((passes[0] as { steps: unknown[] }).steps).toHaveLength(0);
  });

  it('plans an empty chain to a single copy pass (pass 0 doubles as extraction)', () => {
    const passes = planFilterPasses([]);
    expect(passes.map((p) => p.kind)).toEqual(['pointwise']);
  });
});

describe('blurTaps', () => {
  it('scales with radius and caps at 64', () => {
    expect(blurTaps(2)).toBe(5);
    expect(blurTaps(100)).toBe(64);
    expect(blurTaps(0.1)).toBe(1);
  });
});

describe('codegen', () => {
  const size = { w: 320, h: 180 };

  it('bakes matrix literals column-major with float formatting', () => {
    const glsl = passFragmentGlsl(
      { kind: 'pointwise', steps: [{ op: 'colorMatrix', matrix: [1, 2, 3, 4, 5, 6, 7, 8, 9], offset: [0.5, 0, 0] }] },
      size, null,
    );
    // columns of the row-major input: (1,4,7), (2,5,8), (3,6,9)
    expect(glsl).toContain('mat3(1.0, 4.0, 7.0, 2.0, 5.0, 8.0, 3.0, 6.0, 9.0)');
    expect(glsl).toContain('vec3(0.5, 0.0, 0.0)');
    // integers must never leak as int literals into float context
    expect(glsl).not.toMatch(/vec3\(0,/);
  });

  it('bakes the srcRect extraction remap into pass 0 only', () => {
    const ex = { srcRect: { x: 32, y: 18, w: 160, h: 90 }, source: { w: 320, h: 180 } };
    const glsl = passFragmentGlsl({ kind: 'pointwise', steps: [] }, size, ex);
    expect(glsl).toContain('vec2(0.1, 0.1)');   // offset 32/320, 18/180
    expect(glsl).toContain('vec2(0.5, 0.5)');   // scale 160/320, 90/180
    const identity = passFragmentGlsl({ kind: 'pointwise', steps: [] }, size, null);
    expect(identity).toContain('texture(uTex, vUv)');
  });

  it('emits axis-correct blur with baked taps', () => {
    const gx = passFragmentGlsl({ kind: 'blur', axis: 'x', radius: 4 }, size, null);
    expect(gx).toContain(`vec2(${1 / 320}, 0.0)`);
    expect(gx).toContain(`i <= ${blurTaps(4)}`);
    const gy = passFragmentGlsl({ kind: 'blur', axis: 'y', radius: 4 }, size, null);
    expect(gy).toContain(`vec2(0.0, ${1 / 180}`);
  });

  it('WGSL mirrors GLSL structure (external only legal on pointwise pass 0)', () => {
    const w = passModuleWgsl({ kind: 'pointwise', steps: [cm(0.5) as never] }, size, null, true);
    expect(w).toContain('texture_external');
    expect(w).toContain('textureSampleBaseClampToEdge');
    const b = passModuleWgsl({ kind: 'blur', axis: 'x', radius: 4 }, size, null, false);
    expect(b).toContain('textureSampleLevel');
    expect(() => passModuleWgsl({ kind: 'blur', axis: 'x', radius: 4 }, size, null, true)).toThrow();
  });
});
