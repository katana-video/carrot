/**
 * Backend selection: probe in preference order, honest failure otherwise.
 * The chosen backend is a capability dimension — preflight reports it, and
 * kernel availability keys off it (OpDef.lower.backends).
 */

import type { Backend } from '../schema';
import type { CompositeRenderer, RendererInit } from './types';
import { createWebGPURenderer, getWebGPUDevice } from './webgpu';
import { createWebGL2Renderer } from './webgl2';

export * from './types';
export { createWebGPURenderer, getWebGPUDevice } from './webgpu';
export { createWebGL2Renderer } from './webgl2';
export { planFilterPasses, blurTaps } from './filters';
export type { FilterPass, PointwiseStep } from './filters';

let probed: Backend | null | undefined;

/** Probe once per context: webgpu preferred, webgl2 fallback, null if neither. */
export async function probeBackend(): Promise<Backend | null> {
  if (probed !== undefined) return probed;
  try {
    await getWebGPUDevice();
    probed = 'webgpu';
  } catch {
    try {
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
      probed = gl ? 'webgl2' : null;
    } catch {
      probed = null;
    }
  }
  return probed;
}

export async function createRenderer(
  backend: Backend | 'auto',
  init: RendererInit,
): Promise<CompositeRenderer> {
  const resolved = backend === 'auto' ? await probeBackend() : backend;
  if (resolved === 'webgpu') return createWebGPURenderer(init);
  if (resolved === 'webgl2') return createWebGL2Renderer(init);
  throw new Error('no GPU backend available (webgpu/webgl2 both unavailable)');
}
