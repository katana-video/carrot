/**
 * CFR conform sink [D5] — re-times decoded video onto a constant-fps grid
 * with ffmpeg fps-filter semantics (round=near): each input frame maps to
 * slot round(t·fps); the first frame of a slot wins (later same-slot frames
 * drop); gaps between slots are filled by duplicating the held frame; flush
 * pads the tail to the output duration. Sits closest to the encoder so
 * kernels (upscale etc.) process each SOURCE frame once and duplicates
 * re-encode the already-processed frame.
 *
 * Ownership: callers close their samples after add() (sinkNode contract), so
 * the held frame is a CLONE; emissions are clones of the clone, closed after
 * the inner add. addOptions (span-start keyFrame) forward with the frame's
 * first emission only.
 *
 * Samples are duck-typed (clone/setTimestamp/close) so the grid logic is
 * unit-testable without WebCodecs.
 */

export interface ConformableSample {
  timestamp: number;
  clone(): unknown;
  setTimestamp(t: number): void;
  close(): void;
}

interface VideoLikeSink<S> { add(sample: S, opts?: unknown): Promise<void> | void; close?(): void }

export interface ConformSink<S extends ConformableSample> {
  add(sample: S, opts?: unknown): Promise<void>;
  /** Emit the held frame (padding to `endTime` when given), then release. */
  flush(endTime?: number): Promise<void>;
  close(): void;
}

export function conformVideoSink<S extends ConformableSample>(
  inner: VideoLikeSink<S>,
  fps: number,
): ConformSink<S> {
  let pending: S | null = null;
  let pendingSlot = 0;
  let pendingOpts: unknown;

  async function emit(slot: number, first: boolean): Promise<void> {
    const out = pending!.clone() as S;
    out.setTimestamp(slot / fps);
    try {
      await inner.add(out, first ? pendingOpts : undefined);
    } finally {
      out.close();
    }
  }

  async function drain(untilSlot: number): Promise<void> {
    for (let k = pendingSlot; k < untilSlot; k++) await emit(k, k === pendingSlot);
    pending!.close();
    pending = null;
  }

  return {
    async add(sample: S, opts?: unknown): Promise<void> {
      const slot = Math.max(0, Math.round(sample.timestamp * fps));
      if (pending) {
        if (slot <= pendingSlot) return; // same grid slot — first frame wins
        await drain(slot);
      }
      pending = sample.clone() as S;
      pendingSlot = slot;
      pendingOpts = opts;
    },

    async flush(endTime?: number): Promise<void> {
      if (!pending) return;
      // pad up to (but excluding) the slot that would start at/after endTime;
      // a frame rounded past the end is dropped — output duration stays exact
      const endSlot = endTime !== undefined
        ? Math.ceil(endTime * fps - 1e-6)
        : pendingSlot + 1;
      if (endSlot <= pendingSlot) {
        pending.close();
        pending = null;
        return;
      }
      await drain(endSlot);
    },

    close(): void {
      pending?.close();
      pending = null;
      inner.close?.();
    },
  };
}
