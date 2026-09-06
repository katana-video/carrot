/**
 * QR code generation — the engine's one pure generator capability (no input
 * asset). Encoding (Reed-Solomon, masking, version selection) is
 * qrcode-generator (Kazuhiko Arase, MIT); this module owns the byte mapping
 * and the rendering surfaces (SVG string, PNG blob).
 *
 * Import via the './qr' subpath (or dynamically from the pipeline executor) —
 * never through the barrel, so the encoder stays off every entry bundle.
 */

import qrcode from 'qrcode-generator';

// The library's default stringToBytes is charCode & 0xff (latin-1-ish): it
// silently corrupts non-ASCII text. UTF-8 is the de-facto byte-mode
// interpretation every phone scanner assumes — install it once, unconditionally
// (this module is the only import path in the repo).
const utf8 = new TextEncoder();
qrcode.stringToBytes = (s: string) => [...utf8.encode(s)];

/** IR-facing vocabulary → the spec's L/M/Q/H. */
export type QrEcLevel = 'low' | 'medium' | 'quartile' | 'high';
const EC: Record<QrEcLevel, 'L' | 'M' | 'Q' | 'H'> = {
  low: 'L', medium: 'M', quartile: 'Q', high: 'H',
};

export interface QrMatrix {
  /** Modules per side (21–177 depending on the auto-picked version). */
  modules: number;
  dark(row: number, col: number): boolean;
}

/** Spec quiet zone: 4 modules of white on every side. Both renderers bake it
 * in — callers never manage margins. */
const QUIET = 4;

/**
 * Encode text into a QR module matrix. Version (size) is auto-picked for the
 * payload; throws RangeError when the text cannot fit (~2.9KB binary at 'low',
 * less at higher correction levels).
 */
export function encodeQr(text: string, ec: QrEcLevel = 'medium'): QrMatrix {
  if (!text) throw new RangeError('QR text is empty');
  const qr = qrcode(0, EC[ec]);
  qr.addData(text, 'Byte');
  try {
    qr.make();
  } catch (e) {
    // the library throws plain Errors like 'code length overflow. (2957>2956)'
    throw new RangeError(`text is too long for a QR code at '${ec}' error correction (${
      e instanceof Error ? e.message : String(e)})`);
  }
  return { modules: qr.getModuleCount(), dark: (row, col) => qr.isDark(row, col) };
}

/** Crisp scalable SVG: quiet-zone white ground + one path of unit squares.
 * width/height are advisory (viewBox scales losslessly). */
export function qrSvg(m: QrMatrix, sizePx = 1024): string {
  const side = m.modules + 2 * QUIET;
  let d = '';
  for (let row = 0; row < m.modules; row++) {
    for (let col = 0; col < m.modules; col++) {
      if (m.dark(row, col)) d += `M${col + QUIET} ${row + QUIET}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#ffffff"/><path d="${d}" fill="#000000"/></svg>`;
}

/**
 * Exact-size PNG. Module edges land on rounded pixel boundaries (adjacent
 * modules share the exact same edge), so there is zero anti-aliasing even
 * when size doesn't divide evenly by the module count.
 */
export async function qrPngBlob(m: QrMatrix, size = 1024): Promise<Blob> {
  const side = m.modules + 2 * QUIET;
  const scale = size / side;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  const edge = (units: number) => Math.round(units * scale);
  for (let row = 0; row < m.modules; row++) {
    for (let col = 0; col < m.modules; col++) {
      if (!m.dark(row, col)) continue;
      const x = edge(col + QUIET), y = edge(row + QUIET);
      ctx.fillRect(x, y, edge(col + QUIET + 1) - x, edge(row + QUIET + 1) - y);
    }
  }
  return canvas.convertToBlob({ type: 'image/png' });
}
