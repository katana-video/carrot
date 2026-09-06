/**
 * Streaming sink correctness [docs/streaming-output-plan.md]: a stream-copy
 * render (no WebCodecs needed, so it runs in Node against REAL mediabunny)
 * must produce byte-identical output through StreamTarget positioned writes
 * vs the BufferTarget path. Skips when the generated harness fixture is
 * absent (harness/fixtures/ is gitignored — `node harness/run.mjs` generates it).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { StreamTargetChunk } from 'mediabunny';
import { probe } from '../src/probe';
import { factsFromProbe } from '../src/ir/facts';
import { plan } from '../src/ir/plan';
import { execute } from '../src/executor/execute';

const FIXTURE = new URL('../harness/fixtures/fA.mp4', import.meta.url).pathname;

describe.skipIf(!existsSync(FIXTURE))('execute(): sink streaming (real copy mux)', () => {
  it('streamed output is byte-identical to the buffered output', async () => {
    const blob = new Blob([readFileSync(FIXTURE)], { type: 'video/mp4' });
    const facts = factsFromProbe(await probe(blob));
    // video copy, audio dropped: AAC priming makes the audio lane
    // re-encode [D1], and Node has no encoder — copy exercises the real
    // muxer both ways, which is what this test is about.
    const r = plan({
      version: '0.1',
      assets: { a: { kind: 'video' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        output: { container: 'mkv', video: { codec: 'auto' } },
      }],
    }, { a: facts });
    expect(r.errors).toEqual([]);
    expect(r.plan!.strategy.video).toBe('copy');

    const assets = { a: { kind: 'video' as const, source: blob, label: 'a.mp4' } };
    const buffered = await execute(r.plan!, assets, {});
    expect(buffered.blob).not.toBeNull();

    const chunks: StreamTargetChunk[] = [];
    const sink = new WritableStream<StreamTargetChunk>({ write(c) { chunks.push(c); } });
    const streamed = await execute(r.plan!, assets, { sink });
    expect(streamed.blob).toBeNull();

    const end = Math.max(...chunks.map((c) => c.position + c.data.byteLength));
    const out = new Uint8Array(end);
    for (const c of chunks) out.set(c.data, c.position);
    const ref = new Uint8Array(await buffered.blob!.arrayBuffer());
    expect(out.length).toBe(ref.length);
    expect(Buffer.from(out).equals(Buffer.from(ref))).toBe(true);
  });
});
