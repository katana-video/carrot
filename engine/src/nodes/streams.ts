/**
 * Core stream nodes — the boundary adapters and small transforms every lane
 * is built from. Convention (schema.ts glossary): source node = ReadableStream,
 * sink node = WritableStream, everything between = TransformStream.
 *
 * All nodes are pull-based; backpressure, EOS, and cancellation propagate
 * through native stream mechanics (proven E1). No timers, no counters, no
 * watchdogs — completion is structural.
 */

import type { Sec } from '../schema';

/** Anything with refcount-style lifetime (VideoSample, AudioSample, …). */
export interface Closable { close(): void }
export interface Timed { timestamp: Sec; duration: Sec }
export interface Retimeable extends Timed { setTimestamp(t: Sec): void; setDuration?(d: Sec): void }
export interface Cloneable<T> extends Closable { clone(): T }

/**
 * Source node: wrap a Mediabunny async iterator (or any async iterable) as a
 * pull-based ReadableStream. Decode happens on pull; cancel() propagates into
 * the iterator's cleanup path.
 */
export function sourceNode<T>(src: AsyncIterable<T>, highWaterMark = 4): ReadableStream<T> {
  const it = src[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const r = await it.next();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    async cancel(reason) {
      await it.return?.(reason);
    },
  }, new CountQueuingStrategy({ highWaterMark }));
}

export interface SinkOptions<T> {
  onWritten?: (sample: T) => void;
  /** Per-write options forwarded as add()'s second argument (e.g. {keyFrame:true}). */
  addOptions?: (sample: T) => unknown;
  /**
   * When false, the underlying Mediabunny source is NOT closed when this
   * stream ends — required for multi-span jobs where one encoder outlives
   * many per-span sink streams. The executor closes sources after the last
   * span.
   */
  closeSource?: boolean;
}

/**
 * Sink node: wrap a Mediabunny sample source as a WritableStream. add()'s
 * pending promise IS the backpressure (encoder/muxer busy → write() pends →
 * the whole lane slows down to match).
 */
export function sinkNode<T extends Closable>(
  source: { add(sample: T, opts?: unknown): Promise<void>; close(): void },
  opts: SinkOptions<T> = {},
): WritableStream<T> {
  return new WritableStream<T>({
    async write(sample) {
      try {
        await source.add(sample, opts.addOptions?.(sample));
        opts.onWritten?.(sample);
      } finally {
        sample.close();
      }
    },
    close() {
      if (opts.closeSource !== false) source.close();
    },
    abort() {
      if (opts.closeSource !== false) source.close();
    },
  });
}

/** Transform node: keep samples where pred is true; close the rest.
 * The span-boundary policy for video (frames drop; audio trims — see audio.ts). */
export function gate<T extends Closable>(pred: (s: T) => boolean): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(s, controller) {
      if (pred(s)) controller.enqueue(s);
      else s.close();
    },
  });
}

/** Transform node: map timestamps into output time — t' = t/rate + offset,
 * durations scale by 1/rate (the binding's time map — the only place source
 * time becomes output time). rate ≠ 1 is the speed path. */
export function rebase<T extends Retimeable>(offset: Sec, rate = 1): TransformStream<T, T> {
  if (offset === 0 && rate === 1) return new TransformStream<T, T>();
  return new TransformStream<T, T>({
    transform(s, controller) {
      s.setTimestamp(s.timestamp / rate + offset);
      if (rate !== 1) s.setDuration?.(s.duration / rate);
      controller.enqueue(s);
    },
  });
}

export interface Progress {
  items: number;
  /** Furthest end-timestamp seen, seconds — progress fractions come from
   * mediaTime / span duration, never from item counts (VFR-safe). */
  mediaTime: Sec;
}

/** Transform node: identity pass-through measuring flow at the edge it sits on. */
export function progressNode<T extends Partial<Timed>>(
  onUpdate: (p: Readonly<Progress>) => void,
): TransformStream<T, T> {
  const p: Progress = { items: 0, mediaTime: 0 };
  return new TransformStream<T, T>({
    transform(item, controller) {
      p.items++;
      if (typeof item.timestamp === 'number') {
        p.mediaTime = Math.max(p.mediaTime, item.timestamp + (item.duration ?? 0));
      }
      onUpdate(p);
      controller.enqueue(item);
    },
  });
}

/**
 * Fan-out node: N branches, each receiving its OWN clone (independently
 * closeable reference to the same underlying resource). Never use native
 * ReadableStream.tee() for media samples — branches would share objects and
 * the first close() would kill the sample for the other branch, and native
 * tee buffers unboundedly behind a slow consumer. This tee advances at the
 * pace of the slowest branch (single shared pull).
 */
export function tee<T extends Cloneable<T>>(
  src: ReadableStream<T>,
  count: number,
): ReadableStream<T>[] {
  const reader = src.getReader();
  const controllers: (ReadableStreamDefaultController<T> | null)[] = new Array(count).fill(null);
  let pending: Promise<void> | null = null;

  const pullShared = () => {
    pending ??= (async () => {
      const r = await reader.read();
      for (let i = 0; i < count; i++) {
        const c = controllers[i];
        if (!c) continue;
        if (r.done) c.close();
        else c.enqueue(i === 0 ? r.value : r.value.clone());
      }
      pending = null;
    })();
    return pending;
  };

  let open = count;
  return Array.from({ length: count }, (_, i) =>
    new ReadableStream<T>({
      start(c) { controllers[i] = c; },
      pull: pullShared,
      async cancel(reason) {
        controllers[i] = null;
        if (--open === 0) await reader.cancel(reason);
      },
    }, new CountQueuingStrategy({ highWaterMark: 1 })));
}
