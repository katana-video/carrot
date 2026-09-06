/**
 * Fan-in node — N-ary aligned merge with ffmpeg framesync semantics.
 *
 * Slot stream 0 is the PRIMARY (the timing reference; schema invariant).
 * For each primary sample at time t, every secondary advances to its sample
 * with the nearest timestamp <= t (framesync 'nearest-lower'); a secondary
 * that ends holds its last sample (`repeatlast`). Emitted maps carry the
 * consumer's OWN clones — the consumer closes every value in the map
 * (clone-per-emission ownership; the E2 lifetime lesson).
 *
 * Buffering is structurally bounded: one held + one lookahead sample per
 * secondary, regardless of rate mismatch (pull-based demand).
 */

import type { VideoSample } from 'mediabunny';

export type SlotFrames = Map<number, VideoSample>;

export function mergeSlots(slotStreams: ReadableStream<VideoSample>[]): ReadableStream<SlotFrames> {
  const primary = slotStreams[0];
  if (!primary) throw new Error('mergeSlots: at least one slot stream required');
  const secondaries = slotStreams.slice(1);

  const pr = primary.getReader();
  const srs = secondaries.map((s) => s.getReader());
  const held: (VideoSample | null)[] = secondaries.map(() => null);
  const ahead: (VideoSample | null)[] = secondaries.map(() => null);
  const ended: boolean[] = secondaries.map(() => false);

  const closeAll = () => {
    for (const h of held) h?.close();
    for (const a of ahead) a?.close();
  };

  return new ReadableStream<SlotFrames>({
    async pull(controller) {
      const r = await pr.read();
      if (r.done) {
        closeAll();
        controller.close();
        await Promise.all(srs.map((sr) => sr.cancel()));
        return;
      }
      const t = r.value.timestamp;

      for (let i = 0; i < srs.length; i++) {
        while (!ended[i]) {
          let a = ahead[i];
          if (!a) {
            const n = await srs[i]!.read();
            if (n.done) { ended[i] = true; break; }
            a = n.value;
            ahead[i] = a;
          }
          if (a.timestamp <= t) {
            held[i]?.close();
            held[i] = a;
            ahead[i] = null;
          } else break;
        }
      }

      const frames: SlotFrames = new Map([[0, r.value]]);
      held.forEach((h, i) => { if (h) frames.set(i + 1, h.clone()); });
      controller.enqueue(frames);
    },
    async cancel(reason) {
      closeAll();
      await Promise.all([pr.cancel(reason), ...srs.map((sr) => sr.cancel(reason))]);
    },
  }, new CountQueuingStrategy({ highWaterMark: 2 }));
}

/** Uniform shape for the solo case: a single slot stream as SlotFrames maps. */
export function soloSlot(slotStream: ReadableStream<VideoSample>): ReadableStream<SlotFrames> {
  return slotStream.pipeThrough(new TransformStream<VideoSample, SlotFrames>({
    transform(s, controller) { controller.enqueue(new Map([[0, s]])); },
  }));
}
