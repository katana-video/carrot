// Minimal WAV I/O for the denoise fixtures (48 kHz mono s16le only).
import { readFileSync } from 'node:fs'

export function readWav(path: string): { sampleRate: number; samples: Float32Array } {
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${path}: not a RIFF/WAVE file`)
  let off = 12
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${path}: data before fmt`)
      if (fmt.channels !== 1 || fmt.bits !== 16)
        throw new Error(`${path}: expected mono s16le, got ${fmt.channels}ch ${fmt.bits}-bit`)
      const n = size / 2
      const samples = new Float32Array(n)
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(off + 8 + i * 2) / 32768
      return { sampleRate: fmt.sampleRate, samples }
    }
    off += 8 + size + (size & 1)
  }
  throw new Error(`${path}: no data chunk`)
}
