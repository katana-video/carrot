/**
 * Audio-window extraction (denoise preview support): a short slice of the
 * source decoded to 48 kHz mono f32 (the DFN kernel's native rate), via
 * mediabunny's trim — no whole-file decode. Lives engine-side so the worker
 * host can serve it and the main thread never needs mediabunny.
 */
import {
  ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WavOutputFormat,
} from 'mediabunny';

export async function extractAudioWindow48k(blob: Blob, start: number, end: number): Promise<Float32Array> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const target = new BufferTarget();
  const output = new Output({ format: new WavOutputFormat(), target });
  const conversion = await Conversion.init({
    input, output,
    trim: { start, end },
    video: { discard: true },
    audio: { codec: 'pcm-f32', sampleRate: 48000, numberOfChannels: 1 },
  });
  await conversion.execute();
  const buf = target.buffer!;
  const view = new DataView(buf);
  let off = 12;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
    const size = view.getUint32(off + 4, true);
    if (id === 'data') return new Float32Array(buf, off + 8, size / 4);
    off += 8 + size + (size & 1);
  }
  throw new Error('audio window extraction produced no data chunk');
}
