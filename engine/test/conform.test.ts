/**
 * CFR conform sink [D5] — grid semantics over duck-typed samples (ffmpeg
 * fps-filter round=near: first-of-slot wins, dups fill gaps, flush pads the
 * tail to the output duration).
 */
import { describe, expect, it } from 'vitest';
import { conformVideoSink, type ConformableSample } from '../src/executor/conform';

class FakeSample implements ConformableSample {
  closed = false;
  constructor(public timestamp: number, public id: string) {}
  clone(): FakeSample {
    return new FakeSample(this.timestamp, this.id);
  }
  setTimestamp(t: number): void { this.timestamp = t; }
  close(): void { this.closed = true; }
}

function collector() {
  const out: { id: string; t: number; opts: unknown }[] = [];
  return {
    out,
    sink: {
      add(s: FakeSample, opts?: unknown) {
        out.push({ id: s.id, t: Math.round(s.timestamp * 1000) / 1000, opts });
      },
    },
  };
}

describe('conformVideoSink', () => {
  it('30fps → 10fps: keeps the first frame of each slot, drops the rest', async () => {
    const { out, sink } = collector();
    const c = conformVideoSink(sink, 10);
    // 30fps input: t = 0, 1/30, 2/30, ... 8/30 (9 frames, 0.3s)
    for (let i = 0; i < 9; i++) await c.add(new FakeSample(i / 30, `f${i}`));
    await c.flush(0.3);
    // slots: f0→0, f1(0.033→slot0 drop), f2(0.067→slot1), f3(0.1→slot1 drop)...
    expect(out.map((o) => o.id)).toEqual(['f0', 'f2', 'f5', ...[]]);
    expect(out.map((o) => o.t)).toEqual([0, 0.1, 0.2]);
  });

  it('10fps → 30fps: duplicates into the gaps', async () => {
    const { out, sink } = collector();
    const c = conformVideoSink(sink, 30);
    await c.add(new FakeSample(0, 'a'));
    await c.add(new FakeSample(0.1, 'b'));
    await c.flush(0.2);
    expect(out.map((o) => o.id)).toEqual(['a', 'a', 'a', 'b', 'b', 'b']);
    expect(out.map((o) => o.t)).toEqual([0, 1 / 30, 2 / 30, 0.1, 0.1 + 1 / 30, 0.1 + 2 / 30].map((t) => Math.round(t * 1000) / 1000));
  });

  it('flush pads the tail to the output duration', async () => {
    const { out, sink } = collector();
    const c = conformVideoSink(sink, 10);
    await c.add(new FakeSample(0, 'only'));
    await c.flush(0.5);
    expect(out).toHaveLength(5);
    expect(out.every((o) => o.id === 'only')).toBe(true);
  });

  it('forwards addOptions (keyFrame) only on a frame’s first emission', async () => {
    const { out, sink } = collector();
    const c = conformVideoSink(sink, 30);
    await c.add(new FakeSample(0, 'a'), { keyFrame: true });
    await c.add(new FakeSample(0.1, 'b'));
    await c.flush(0.2);
    expect(out[0]!.opts).toEqual({ keyFrame: true });
    expect(out.slice(1).every((o) => o.opts === undefined)).toBe(true);
  });

  it('caller keeps ownership: input samples are never closed by add', async () => {
    const { sink } = collector();
    const c = conformVideoSink(sink, 10);
    const s = new FakeSample(0, 'a');
    await c.add(s);
    expect(s.closed).toBe(false); // held frame is a clone
    await c.flush(0.1);
  });
});
