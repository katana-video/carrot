/**
 * detectTruncatedTail() [2026-08-10] — the Android media-provider stale-size
 * case: a file served SHORTER than its container declares (observed live: a
 * Samsung voice-recorder m4a whose tail moov was cut 1543 bytes early,
 * demuxing to zero tracks). Synthetic ISO-BMFF fixtures, header math only.
 */
import { describe, expect, it } from 'vitest';
import { detectTruncatedTail } from '../src/probe';

function box(type: string, payload: number): Uint8Array {
  const size = 8 + payload;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  return out;
}

const file = (...parts: Uint8Array[]): Blob => new Blob(parts as BlobPart[]);

const FTYP = box('ftyp', 16);
const MDAT = box('mdat', 512);
const MOOV = box('moov', 300);

describe('detectTruncatedTail()', () => {
  it('a complete file is not truncated', async () => {
    expect(await detectTruncatedTail(file(FTYP, MDAT, MOOV))).toBeUndefined();
  });

  it('a tail box cut mid-way is reported with declared vs present', async () => {
    const whole = file(FTYP, MDAT, MOOV.subarray(0, 100));
    expect(await detectTruncatedTail(whole)).toEqual({
      box: 'moov', declaredBytes: 308, presentBytes: 100,
    });
  });

  it('a trailing partial box header is reported', async () => {
    const whole = file(FTYP, MDAT, MOOV.subarray(0, 5));
    expect(await detectTruncatedTail(whole)).toEqual({
      box: '(box header)', declaredBytes: 8, presentBytes: 5,
    });
  });

  it('size=0 (extends to end of file) is valid, never truncated', async () => {
    const open = box('mdat', 64);
    new DataView(open.buffer).setUint32(0, 0);
    expect(await detectTruncatedTail(file(FTYP, open))).toBeUndefined();
  });

  it('non-BMFF containers are not judged', async () => {
    const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 1, 2, 3]);
    expect(await detectTruncatedTail(file(ebml))).toBeUndefined();
  });
});
