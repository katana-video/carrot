/**
 * QR generation validated by round-trip DECODE (jsQR as the oracle) — this
 * catches the failure modes structural checks can't: row/col transposition,
 * quiet-zone omission, and the UTF-8 byte-mapping override.
 */
import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { encodeQr, qrSvg, type QrMatrix } from '../src/qr';

/** Rasterize the matrix to RGBA the same way qrPngBlob lays out pixels
 * (quiet zone included) — jsQR consumes ImageData-shaped buffers. */
function rgba(m: QrMatrix, scale = 8): { data: Uint8ClampedArray; size: number } {
  const side = (m.modules + 8) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let row = 0; row < m.modules; row++) {
    for (let col = 0; col < m.modules; col++) {
      if (!m.dark(row, col)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((row + 4) * scale + dy) * side + (col + 4) * scale + dx;
          data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return { data, size: side };
}

function decode(m: QrMatrix): string | null {
  const { data, size } = rgba(m);
  return jsQR(data, size, size)?.data ?? null;
}

describe('encodeQr', () => {
  it('round-trips a URL', () => {
    expect(decode(encodeQr('https://katana.video/tools/'))).toBe('https://katana.video/tools/');
  });

  it('round-trips UTF-8 text (the stringToBytes override)', () => {
    const text = 'こんにちは Katana — प्रणाम';
    expect(decode(encodeQr(text))).toBe(text);
  });

  it('honors error-correction levels (higher EC → same or bigger version)', () => {
    const text = 'https://katana.video/some/moderately/long/path?with=params';
    const low = encodeQr(text, 'low');
    const high = encodeQr(text, 'high');
    expect(high.modules).toBeGreaterThanOrEqual(low.modules);
    expect(decode(high)).toBe(text);
  });

  it('rejects empty and oversized payloads with RangeError', () => {
    expect(() => encodeQr('')).toThrow(RangeError);
    expect(() => encodeQr('x'.repeat(5000))).toThrow(RangeError);
  });
});

describe('qrSvg', () => {
  it('emits a scalable svg with quiet zone and only white/black', () => {
    const m = encodeQr('https://katana.video');
    const svg = qrSvg(m, 512);
    const side = m.modules + 8;
    expect(svg).toContain(`viewBox="0 0 ${side} ${side}"`);
    expect(svg).toContain('width="512"');
    expect(svg).toContain('#ffffff');
    expect(svg).toContain('#000000');
    // top-left finder pattern's first dark module sits at the quiet-zone offset
    expect(svg).toContain('M4 4h1v1h-1z');
  });
});
