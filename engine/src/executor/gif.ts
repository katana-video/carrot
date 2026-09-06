/**
 * GIF encoder node [D9] — Mediabunny has no GIF output, so this is the one
 * hand-rolled encoder in the engine. Duck-types the video lane's sink
 * interface ({add, close}), so the normal span-loop render path feeds it.
 *
 * Encoding choices (v0.1, deterministic):
 * - Fixed global 6×7×6 RGB palette (252 colors) + Floyd–Steinberg dithering —
 *   no per-frame palette computation, stable output across runs.
 * - Frame delays in centiseconds from REAL timestamps with error accumulation
 *   (30fps → alternating 3/4cs, staying in sync), floor 2cs (browsers clamp
 *   shorter delays to 10cs).
 * - Infinite loop via NETSCAPE2.0.
 */

import type { VideoSample } from 'mediabunny';

const LEVELS_R = 6, LEVELS_G = 7, LEVELS_B = 6;   // 252 entries

function buildPalette(): Uint8Array {
  const pal = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < LEVELS_R; r++) {
    for (let g = 0; g < LEVELS_G; g++) {
      for (let b = 0; b < LEVELS_B; b++) {
        pal[i * 3] = Math.round((r * 255) / (LEVELS_R - 1));
        pal[i * 3 + 1] = Math.round((g * 255) / (LEVELS_G - 1));
        pal[i * 3 + 2] = Math.round((b * 255) / (LEVELS_B - 1));
        i++;
      }
    }
  }
  return pal;  // entries 252..255 stay black padding
}

/** Floyd–Steinberg dither RGBA → palette indices (serpentine-free, simple). */
function quantize(rgba: Uint8ClampedArray, w: number, h: number, pal: Uint8Array): Uint8Array {
  const idx = new Uint8Array(w * h);
  // error buffers per channel for current and next row
  const err = new Float32Array((w + 2) * 3 * 2);
  const rowOff = (row: number) => (row % 2) * (w + 2) * 3;
  for (let y = 0; y < h; y++) {
    const cur = rowOff(y), next = rowOff(y + 1);
    err.fill(0, next, next + (w + 2) * 3);
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const e = cur + (x + 1) * 3;
      const r = Math.max(0, Math.min(255, rgba[p]! + err[e]!));
      const g = Math.max(0, Math.min(255, rgba[p + 1]! + err[e + 1]!));
      const b = Math.max(0, Math.min(255, rgba[p + 2]! + err[e + 2]!));
      const qr = Math.round((r * (LEVELS_R - 1)) / 255);
      const qg = Math.round((g * (LEVELS_G - 1)) / 255);
      const qb = Math.round((b * (LEVELS_B - 1)) / 255);
      const pi = (qr * LEVELS_G + qg) * LEVELS_B + qb;
      idx[y * w + x] = pi;
      const er = r - pal[pi * 3]!, eg = g - pal[pi * 3 + 1]!, eb = b - pal[pi * 3 + 2]!;
      const spread = (o: number, fr: number) => {
        err[o] = err[o]! + er * fr;
        err[o + 1] = err[o + 1]! + eg * fr;
        err[o + 2] = err[o + 2]! + eb * fr;
      };
      spread(cur + (x + 2) * 3, 7 / 16);       // right
      spread(next + x * 3, 3 / 16);            // down-left
      spread(next + (x + 1) * 3, 5 / 16);      // down
      spread(next + (x + 2) * 3, 1 / 16);      // down-right
    }
  }
  return idx;
}

/** GIF-variant LZW: min code size 8, clear=256, eof=257, 12-bit cap. */
function lzwEncode(indices: Uint8Array, push: (byte: number) => void): void {
  const MIN = 8, CLEAR = 1 << MIN, EOF_ = CLEAR + 1;
  let codeSize = MIN + 1;
  let next = EOF_ + 1;
  let dict = new Map<number, number>();
  let bitBuf = 0, bitLen = 0;
  const emit = (code: number) => {
    bitBuf |= code << bitLen;
    bitLen += codeSize;
    while (bitLen >= 8) { push(bitBuf & 0xff); bitBuf >>= 8; bitLen -= 8; }
  };
  emit(CLEAR);
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!;
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    dict.set(key, next);
    if (next === 1 << codeSize && codeSize < 12) codeSize++;
    next++;
    if (next === 4096) {
      emit(CLEAR);
      dict = new Map();
      codeSize = MIN + 1;
      next = EOF_ + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(EOF_);
  if (bitLen > 0) push(bitBuf & 0xff);
}

interface GifFrame { indices: Uint8Array; timestamp: number; duration: number }

export class GifEncoder {
  private readonly palette = buildPalette();
  private readonly frames: GifFrame[] = [];
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;

  constructor(readonly width: number, readonly height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context for gif encoding');
    this.ctx = ctx;
  }

  /** Video-lane sink interface (duck-types VideoSampleSource.add). */
  async add(sample: VideoSample): Promise<void> {
    const frame = sample.toVideoFrame();
    this.ctx.drawImage(frame, 0, 0, this.width, this.height);
    frame.close();
    const rgba = this.ctx.getImageData(0, 0, this.width, this.height).data;
    this.frames.push({
      indices: quantize(rgba, this.width, this.height, this.palette),
      timestamp: sample.timestamp,
      duration: sample.duration,
    });
  }

  close(): void { /* sink contract; assembly happens in finish() */ }

  finish(): Blob {
    if (!this.frames.length) throw new Error('gif output produced no frames');
    const out: number[] = [];
    const u8 = (v: number) => out.push(v & 0xff);
    const u16 = (v: number) => { out.push(v & 0xff, (v >> 8) & 0xff); };
    const str = (s: string) => { for (const ch of s) out.push(ch.charCodeAt(0)); };

    str('GIF89a');
    u16(this.width); u16(this.height);
    u8(0xf7);            // global table, 8-bit color res, 256 entries
    u8(0); u8(0);        // bg index, aspect
    for (const b of this.palette) u8(b);

    // NETSCAPE2.0 infinite loop
    u8(0x21); u8(0xff); u8(11); str('NETSCAPE2.0'); u8(3); u8(1); u16(0); u8(0);

    let carriedCs = 0;   // real time in cs already represented
    this.frames.forEach((f, i) => {
      const endTs = i + 1 < this.frames.length
        ? this.frames[i + 1]!.timestamp
        : f.timestamp + f.duration;
      const targetCs = Math.round(endTs * 100);
      const delay = Math.max(2, targetCs - carriedCs);
      carriedCs += delay;

      u8(0x21); u8(0xf9); u8(4);
      u8(0x04);          // disposal 1 (keep), no transparency
      u16(delay); u8(0); u8(0);

      u8(0x2c);          // image descriptor
      u16(0); u16(0); u16(this.width); u16(this.height);
      u8(0);             // no local table, no interlace

      u8(8);             // LZW min code size
      const data: number[] = [];
      lzwEncode(f.indices, (b) => data.push(b));
      for (let off = 0; off < data.length; off += 255) {
        const n = Math.min(255, data.length - off);
        u8(n);
        for (let j = 0; j < n; j++) u8(data[off + j]!);
      }
      u8(0);             // block terminator
    });
    u8(0x3b);            // trailer
    return new Blob([new Uint8Array(out)], { type: 'image/gif' });
  }
}
