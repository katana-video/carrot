/**
 * removebg deriver over @katana-video/web-bg-removal — the engine's `removebg`
 * step as a host backend (`@katana-video/carrot-backends/removebg`).
 *
 * WORKER-SAFE: ImageBitmap in, ImageBitmap out, PNG via OffscreenCanvas; the
 * package needs no DOM. Weights come from cdn.katana.video (CORS-enabled,
 * immutable, Cache-API cached by the package itself) — no proxy rule needed.
 *
 * Model tiers (the IR's optional `model`, default 'quality'):
 *   quality → birefnet_lite  any subject, fine edges/hair, 86 MB f16
 *   fast    → longpipe-xl    people only, 14.5 MB f16, real-time class
 * One loaded model is kept per worker so a second run in the same session
 * skips both the download (cached anyway) and the pipeline compile.
 */
import type { DeriverBackends, DeriverCtx } from '@katana-video/carrot';
import type { BackgroundRemover, ModelName } from '@katana-video/web-bg-removal';
import { removebgWeightsBase } from './weights';

export type RemovebgModel = 'quality' | 'fast';

export const MODEL_FOR: Record<RemovebgModel, ModelName> = {
  quality: 'birefnet_lite',
  fast: 'longpipe-xl',
};

/** Download size the UI can quote before Start (f16, the auto pick on any
 *  GPU with shader-f16; f32 is double). */
export const REMOVEBG_WEIGHTS_BYTES: Record<RemovebgModel, number> = { quality: 90.2e6, fast: 14.5e6 };
export function removebgWeightsBytes(model: RemovebgModel = 'quality'): number {
  return REMOVEBG_WEIGHTS_BYTES[model];
}

export interface RemovebgOptions {
  /** Mirror of web-bg-removal's weights directory; overrides configureWeights. */
  weightsBaseUrl?: string;
}
let options: RemovebgOptions = {};
/** Optional host configuration (e.g. a self-hosted weights mirror). */
export function configureRemovebg(opts: RemovebgOptions): void { options = { ...opts }; }

let cached: { name: ModelName; remover: Promise<BackgroundRemover> } | null = null;

function getRemover(name: ModelName, ctx: DeriverCtx): Promise<BackgroundRemover> {
  if (cached?.name === name) return cached.remover;
  // switching tiers: release the old pipeline's GPU buffers first
  void cached?.remover.then((r) => r.destroy()).catch(() => {});
  const remover = (async () => {
    // optional peer, loaded on first use — the runtime is ~100 KB, the weights are not
    const { BackgroundRemover, MODELS } = await import('@katana-video/web-bg-removal');
    const total = MODELS[name].weightsBytes.f16;
    const weightsBaseUrl = removebgWeightsBase(options.weightsBaseUrl);
    return BackgroundRemover.load(name, {
      onProgress: (f) => ctx.onModelProgress?.(Math.round(f * total), total),
      ...(weightsBaseUrl ? { weightsBaseUrl } : {}),
    });
  })();
  cached = { name, remover };
  // a failed load must not poison later runs
  remover.catch(() => { if (cached?.remover === remover) cached = null; });
  return remover;
}

export async function removeBackground(
  source: Blob,
  params: Record<string, unknown>,
  ctx: DeriverCtx,
): Promise<Blob> {
  const tier = (params['model'] as RemovebgModel | undefined) ?? 'quality';
  const name = MODEL_FOR[tier] ?? MODEL_FOR.quality;
  ctx.signal.throwIfAborted();
  const remover = await getRemover(name, ctx);
  ctx.signal.throwIfAborted();
  const bitmap = await createImageBitmap(source);
  try {
    ctx.onProgress?.(0);
    const cut = await remover.removeBackground(bitmap);
    const canvas = new OffscreenCanvas(cut.width, cut.height);
    canvas.getContext('2d')!.drawImage(cut, 0, 0);
    cut.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    ctx.onProgress?.(1);
    return blob;
  } finally {
    bitmap.close();
  }
}

/** The `removebg` deriver: pass in `createWorkerHost({ derivers: { removebg } })`. */
export const removebg: NonNullable<DeriverBackends['removebg']> = removeBackground;
/** @deprecated use `removebg` */
export const removebgDeriver = removebg;
