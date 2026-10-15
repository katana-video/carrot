/**
 * One base URL for every byte the backends fetch — so a host can mirror the
 * whole layout and set a single option, or leave the defaults and pull from
 * the public hosts.
 *
 * Defaults (nothing configured):
 *   removebg   web-bg-removal's own default (cdn.katana.video/web-bg-removal/…)
 *   denoise    https://cdn.katana.video/carrot/denoise/v/0.0.5/
 *   enhance    https://cdn.katana.video/carrot/enhance/v/0.1.0/
 *   whisper, translate   the Hugging Face hub (transformers.js defaults)
 *
 * Mirrored layout under `configureWeights({ baseUrl })`:
 *   <base>/removebg/…            web-bg-removal's directory, verbatim
 *   <base>/denoise/v/0.0.5/…     rnnoise.wasm, dfn.wasm, dfn_weights*.pack
 *   <base>/enhance/v/0.1.0/…     chunk_3s_w16.onnx + chunk_3s_w16_weights.bin
 *   <base>/hf/<owner>/<model>/…  a hub repo's files, flat (onnx/…, config.json, …)
 *
 * Every directory we publish carries a manifest.json (sizes + SHA-256) and a
 * WEIGHTS_LICENSE; `manifest.json` under <base>/carrot/ lists all of them.
 *
 * transformers.js' remote settings are PROCESS-GLOBAL (`env.remoteHost`,
 * `env.remotePathTemplate`) — they are only touched when a base URL is
 * configured, and they then apply to every transformers.js pipeline in the
 * same worker. Stated in the docs; the usual worker runs only these backends.
 */

export interface WeightsConfig {
  /** Root of a mirrored weights layout; trailing slash optional. */
  baseUrl?: string;
}

let baseUrl: string | null = null;

export function configureWeights(cfg: WeightsConfig): void {
  baseUrl = cfg.baseUrl ? cfg.baseUrl.replace(/\/?$/, '/') : null;
}

/** The configured base (with trailing slash) or null when using defaults. */
export function weightsBaseUrl(): string | null {
  return baseUrl;
}

export const DENOISE_WEIGHTS_VERSION = '0.0.5';
export const DEFAULT_DENOISE_BASE = `https://cdn.katana.video/carrot/denoise/v/${DENOISE_WEIGHTS_VERSION}/`;

/** Denoise directory: configured mirror or the public default. */
export function denoiseWeightsBase(override?: string): string {
  if (override) return override.replace(/\/?$/, '/');
  return baseUrl ? `${baseUrl}denoise/v/${DENOISE_WEIGHTS_VERSION}/` : DEFAULT_DENOISE_BASE;
}

export const ENHANCE_WEIGHTS_VERSION = '0.1.0';
export const DEFAULT_ENHANCE_BASE = `https://cdn.katana.video/carrot/enhance/v/${ENHANCE_WEIGHTS_VERSION}/`;

/** Voice-enhance (VoiceFixer) directory: configured mirror or the public default. */
export function enhanceWeightsBase(override?: string): string {
  if (override) return override.replace(/\/?$/, '/');
  return baseUrl ? `${baseUrl}enhance/v/${ENHANCE_WEIGHTS_VERSION}/` : DEFAULT_ENHANCE_BASE;
}

/** web-bg-removal directory under a mirror, or undefined for its own default. */
export function removebgWeightsBase(override?: string): string | undefined {
  if (override) return override.replace(/\/?$/, '/');
  return baseUrl ? `${baseUrl}removebg/` : undefined;
}

/**
 * Point transformers.js at the mirror (opt-in: no-op without a base URL).
 * Called by the whisper and translate backends before their first pipeline.
 */
export async function applyTransformersWeightsBase(): Promise<void> {
  if (!baseUrl) return;
  const { env } = await import('@huggingface/transformers');
  env.remoteHost = `${baseUrl}hf/`;
  env.remotePathTemplate = '{model}/';
}

/**
 * Fetch with the browser Cache API when available (workers included), so a
 * mirrored or default URL is downloaded once per origin. Falls back to a
 * plain fetch where `caches` is absent (Node tests).
 */
export async function fetchCached(url: string, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const cacheName = 'carrot-backends-weights';
  let cache: Cache | null = null;
  if (typeof caches !== 'undefined') {
    try {
      cache = await caches.open(cacheName);
      const hit = await cache.match(url);
      if (hit) {
        const buf = await hit.arrayBuffer();
        onProgress?.(buf.byteLength, buf.byteLength);
        return buf;
      }
    } catch { cache = null; }
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`weights fetch failed: ${resp.status} ${url}`);
  const total = Number(resp.headers.get('content-length') ?? 0);
  if (!resp.body || !onProgress) {
    const buf = await resp.arrayBuffer();
    if (cache) cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
    onProgress?.(buf.byteLength, buf.byteLength);
    return buf;
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total || got);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  if (cache) cache.put(url, new Response(out.slice().buffer, { headers: { 'content-type': 'application/octet-stream' } })).catch(() => {});
  return out.buffer;
}
