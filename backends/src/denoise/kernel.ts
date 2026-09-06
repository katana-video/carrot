// Offline audio-denoise kernel driver — the tier-1 [H] runtime, outside the
// engine. Adapted from longpipe's worklet processor (src/audio/worklet/
// processor.ts): same bare-ABI wasm contract, but offline — no AudioWorklet,
// no 128⇄480 ring, no realtime deadline. Feed it any length of 48 kHz mono
// f32 PCM; it runs the streaming kernel hop-by-hop and returns the same
// length. Runtime-agnostic (Node + browser): caller supplies the bytes.

export type DenoiseModel = 'rnnoise' | 'dfn' | 'dfnint8'

export const HOP = 480          // 10 ms @ 48 kHz
export const SAMPLE_RATE = 48000

interface KernelSpec {
  wasm: string
  weights: string | null
  // Sample scaling at the wasm boundary: rnnoise wants int16-magnitude,
  // DFN wants normalized [-1, 1].
  scaleIn: number
  scaleOut: number
  exports: { malloc: string; create: string; process: string }
}

export const KERNELS: Record<DenoiseModel, KernelSpec> = {
  rnnoise: {
    wasm: 'rnnoise.wasm', weights: null, scaleIn: 32768, scaleOut: 1 / 32768,
    exports: { malloc: 'malloc', create: 'rn_create', process: 'rn_process' },
  },
  dfn: {
    wasm: 'dfn.wasm', weights: 'dfn_weights.pack', scaleIn: 1, scaleOut: 1,
    exports: { malloc: 'df_lite_malloc', create: 'df_lite_create', process: 'df_lite_process' },
  },
  dfnint8: {
    wasm: 'dfn.wasm', weights: 'dfn_weights_int8.pack', scaleIn: 1, scaleOut: 1,
    exports: { malloc: 'df_lite_malloc', create: 'df_lite_create_i8', process: 'df_lite_process' },
  },
}

type Fn = (...a: number[]) => number
type WasmExports = Record<string, Fn> & { memory: WebAssembly.Memory }

// Stub every import — the kernels only import panic/clock hooks
// (wbg.__wbindgen_throw, wasi clock_time_get); none carry data we need.
function instantiate(bytes: BufferSource): WasmExports {
  const module = new WebAssembly.Module(bytes as ArrayBuffer)
  const imports: Record<string, Record<string, unknown>> = {}
  for (const im of WebAssembly.Module.imports(module)) {
    const mod = (imports[im.module] ??= {})
    if (im.kind === 'function') mod[im.name] = () => 0
    else if (im.kind === 'memory') mod[im.name] = new WebAssembly.Memory({ initial: 256 })
    else if (im.kind === 'table') mod[im.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' })
    else if (im.kind === 'global') mod[im.name] = new WebAssembly.Global({ value: 'i32', mutable: false }, 0)
  }
  const ex = new WebAssembly.Instance(module, imports as WebAssembly.Imports).exports as WasmExports
  // WASI-reactor builds (rnnoise) expose _initialize for static ctors.
  if (typeof ex._initialize === 'function') ex._initialize()
  return ex
}

/** Strict lookup: the ABI was verified against these binaries; a missing
 * export is a wrong-file error, not an optional path. */
function fn(ex: WasmExports, name: string): Fn {
  const f = ex[name]
  if (typeof f !== 'function') throw new Error(`wasm export '${name}' missing`)
  return f
}

export interface OfflineDenoiser {
  model: DenoiseModel
  /** In-place-safe: input untouched, returns a new Float32Array of equal length. */
  run(samples: Float32Array): Float32Array
  /** Mean wall-clock ms per 10 ms hop over all run() calls so far. */
  msPerHop(): number
}

export function createOfflineDenoiser(
  model: DenoiseModel,
  bytes: { wasm: BufferSource; weights?: BufferSource | null },
): OfflineDenoiser {
  const cfg = KERNELS[model]
  const ex = instantiate(bytes.wasm)
  const malloc = fn(ex, cfg.exports.malloc)
  const proc = fn(ex, cfg.exports.process)
  const create = fn(ex, cfg.exports.create)
  const inPtr = malloc(HOP * 4)
  const outPtr = malloc(HOP * 4)

  let state: number
  if (cfg.weights) {
    const w = bytes.weights
    if (!w) throw new Error(`${model} needs a weights pack (${cfg.weights})`)
    const u8 = new Uint8Array(w as ArrayBuffer)
    const ptr = malloc(u8.length)               // may grow memory
    new Uint8Array(ex.memory.buffer).set(u8, ptr)
    state = create(ptr, u8.length)
  } else {
    state = create()
  }
  if (!state) throw new Error(`${model}: create() returned null state`)

  // Heap view invalidates when wasm memory grows.
  let f32 = new Float32Array(ex.memory.buffer)
  const heap = () => (f32.buffer === ex.memory.buffer ? f32 : (f32 = new Float32Array(ex.memory.buffer)))

  let totalMs = 0
  let hops = 0

  return {
    model,
    run(samples: Float32Array): Float32Array {
      const out = new Float32Array(samples.length)
      const hop = new Float32Array(HOP)
      for (let off = 0; off < samples.length; off += HOP) {
        const n = Math.min(HOP, samples.length - off)
        hop.fill(0)
        hop.set(samples.subarray(off, off + n))
        let h = heap()
        const ib = inPtr >> 2
        for (let i = 0; i < HOP; i++) h[ib + i] = hop[i]! * cfg.scaleIn
        const t0 = performance.now()
        proc(state, inPtr, outPtr)
        totalMs += performance.now() - t0
        hops++
        h = heap()
        const ob = outPtr >> 2
        for (let i = 0; i < n; i++) out[off + i] = h[ob + i]! * cfg.scaleOut
      }
      return out
    },
    msPerHop: () => (hops ? totalMs / hops : 0),
  }
}
