// OPUS-MT translation engine [L3 fallback] — Marian models via
// transformers.js. In the product this is the fallback when Bergamot lacks a
// pair (or fails); in Node it's the primary engine for harness tests
// (Bergamot's wasm is browser-worker-shaped). Per-pair models, ~40 MB q8.
import { env, pipeline } from '@huggingface/transformers'
import type { TranslationModel } from './translateSegments'
import type { TranslationPair } from './route'

env.allowLocalModels = false

export type TranslateDevice = 'cpu' | 'wasm' | 'webgpu'

const cache = new Map<string, Promise<any>>()

function loadPipeline(modelId: string, device: TranslateDevice, onDownload?: (loaded: number, total: number) => void) {
  const key = `${modelId}:${device}`
  let entry = cache.get(key)
  if (!entry) {
    entry = pipeline('translation', modelId, {
      device,
      // q8 works on the Node cpu EP; the old Xenova conversions trip
      // ort-wasm's MatMulNBits transform ("missing required scale") in the
      // browser, where fp32 is the reliable dtype (bigger download, cached).
      dtype: device === 'cpu' ? 'q8' : 'fp32',
      progress_callback: (info: any) => {
        if (info.status === 'progress_total' && onDownload) onDownload(info.loaded, info.total)
      },
    })
    cache.set(key, entry)
    entry.catch(() => cache.delete(key))
  }
  return entry
}

export function opusMtModel(
  device: TranslateDevice = 'cpu',
  onDownload?: (loaded: number, total: number) => void,
): TranslationModel {
  return {
    async translate(texts: string[], pair: TranslationPair): Promise<string[]> {
      const translator = await loadPipeline(pair.modelId, device, onDownload)
      const out = await translator(texts)
      const arr = Array.isArray(out) ? out : [out]
      return arr.map((o: any) => o.translation_text as string)
    },
  }
}
