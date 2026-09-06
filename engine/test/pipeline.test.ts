/**
 * executePipeline() mechanics [G1/G3] — Node-level, mock derivers, mocked
 * render (the real render path is browser-only and covered by the harness).
 */
import { describe, expect, it, vi } from 'vitest';
import { plan } from '../src/ir/plan';
import { executePipeline } from '../src/executor/pipeline';
import { instantPipeline } from '../src/pipeline-info';
import type { AssetTable, CompiledPipeline } from '../src/schema';
import type { FactsTable } from '../src/ir/facts';
import type { Cue } from '../src/executor/vtt';

const FACTS: FactsTable = {
  a: {
    kind: 'video', duration: 8,
    video: { width: 320, height: 180, codec: 'avc', rotation: 0, firstTimestamp: 0 },
    audio: { sampleRate: 48000, channels: 2, codec: 'aac', firstTimestamp: 0 },
  },
  logo: { kind: 'image', duration: Infinity, image: { width: 96, height: 48 } },
  subs: { kind: 'timed-text', duration: 0 },
};

const CUES: Cue[] = [
  { start: 1, end: 3, text: 'Hello subtitles', words: [{ text: 'Hello', start: 1, end: 2 }, { text: 'subtitles', start: 2, end: 3 }], wordTiming: true },
  { start: 5, end: 7, text: 'Second cue', words: [], wordTiming: false },
];

const compile = (operations: unknown[], assets?: Record<string, { kind: string }>): CompiledPipeline => {
  const r = plan({
    version: '0.1',
    assets: assets ?? { a: { kind: 'video' }, logo: { kind: 'image' }, subs: { kind: 'timed-text' } },
    operations,
  }, FACTS);
  expect(r.errors).toEqual([]);
  return r.pipeline!;
};

const table = (): AssetTable => ({
  a: { kind: 'video', source: new Blob(['fake-video']), label: 'a.mp4' },
  logo: { kind: 'image', source: new Blob(['fake-image']), label: 'logo.png' },
  subs: { kind: 'timed-text', source: new Blob(['WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHola']), label: 'subs.vtt' },
});

describe('executePipeline(): deriver mechanics', () => {
  it('transcribe-only delivers a VTT with word timestamps [R1]', async () => {
    const pipeline = compile([{ id: 'caps', op: 'transcribe', source: 'a' }]);
    const transcribe = vi.fn(async (_src: Blob, _params: { model: string; language?: string }) => CUES);
    const r = await executePipeline(pipeline, table(), { derivers: { transcribe } });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe.mock.calls[0]![1]).toEqual({ model: 'base' });
    const text = await r.blob!.text();
    expect(r.blob!.type).toBe('text/vtt');
    expect(text).toContain('WEBVTT');
    expect(text).toContain('00:00:01.000 --> 00:00:03.000');
    expect(text).toContain('Hello <00:00:02.000>subtitles');
  });

  it('srt format serializes at the edge [G3]', async () => {
    const pipeline = compile([{ id: 'caps', op: 'transcribe', source: 'a', format: 'srt' }]);
    const r = await executePipeline(pipeline, table(), { derivers: { transcribe: async () => CUES } });
    const text = await r.blob!.text();
    expect(text.startsWith('1\r\n00:00:01,000 --> 00:00:03,000\r\nHello subtitles')).toBe(true);
  });

  it('transcribe → translate chains cues and drops word timings [L2]', async () => {
    const pipeline = compile([
      { id: 'caps', op: 'transcribe', source: 'a' },
      { id: 'caps_es', op: 'translate', source: 'caps', to: 'es' },
    ]);
    const translate = vi.fn(async (cues: Cue[], _params: { to: string; from?: string }) =>
      cues.map((c) => ({ ...c, text: `[es] ${c.text}` })));
    const r = await executePipeline(pipeline, table(), {
      derivers: { transcribe: async () => CUES, translate },
    });
    expect(translate.mock.calls[0]![0]).toEqual(CUES);       // chained via cue table, no reparse
    expect(translate.mock.calls[0]![1]).toEqual({ to: 'es' });
    const text = await r.blob!.text();
    expect(text).toContain('[es] Hello subtitles');
    expect(text).not.toContain('<00:00:02.000>');            // karaoke marks dropped
    expect(text).toContain('00:00:01.000 --> 00:00:03.000'); // timings preserved
  });

  it('translate consumes a timed-text ASSET by parsing it [L1]', async () => {
    const pipeline = compile([{ id: 'en', op: 'translate', source: 'subs', to: 'en' }]);
    const translate = vi.fn(async (cues: Cue[]) => cues);
    await executePipeline(pipeline, table(), { derivers: { translate } });
    expect(translate.mock.calls[0]![0]).toMatchObject([{ start: 1, end: 3, text: 'Hola' }]);
  });

  it('unreferenced ops DELIVER [G2 amendment]: removebg + transcribe → two outputs', async () => {
    const pipeline = compile([
      { id: 'cut', op: 'removebg', source: 'logo' },
      { id: 'caps', op: 'transcribe', source: 'a' },
    ]);
    expect(pipeline.deliverables).toEqual(['cut', 'caps']);
    const removebg = vi.fn(async () => new Blob(['cut-png'], { type: 'image/png' }));
    const r = await executePipeline(pipeline, table(), {
      derivers: { transcribe: async () => CUES, removebg },
    });
    expect(removebg).toHaveBeenCalledOnce();
    expect(r.outputs.map((o) => o.id)).toEqual(['cut', 'caps']);
    expect(await r.outputs[0]!.blob.text()).toBe('cut-png');
    // primary result = deliver (last authored)
    expect(pipeline.deliver).toBe('caps');
    expect((await r.blob!.text())).toContain('WEBVTT');
  });

  it('three still renders → three outputs in authored order', async () => {
    const extract = (id: string, at: number) => ({
      id, op: 'render',
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', at, name: `frame-${id}` },
    });
    const pipeline = compile([extract('f1', 0), extract('f2', 4), extract('f3', 7)]);
    const renderExec = vi.fn(async (p) =>
      ({ blob: new Blob([`png-at-${p.still.time}`], { type: 'image/png' }), videoCodec: null, audioCodec: null, spanCount: 1 }));
    const r = await executePipeline(pipeline, table(), { renderExec });
    expect(renderExec).toHaveBeenCalledTimes(3);
    expect(r.outputs.map((o) => o.id)).toEqual(['f1', 'f2', 'f3']);
    expect(await r.outputs[1]!.blob.text()).toBe('png-at-4');
    expect(await r.blob!.text()).toBe('png-at-7'); // primary = last authored
  });

  it('render steps receive artifacts as synthetic assets', async () => {
    const pipeline = compile([
      { id: 'caps', op: 'transcribe', source: 'a' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'captions', source: 'caps' }],
        output: { container: 'mp4', video: {}, audio: {} },
      },
    ]);
    const renderExec = vi.fn(async (p, assets: AssetTable) => {
      expect(assets['caps']).toBeDefined();
      expect(assets['caps']!.kind).toBe('timed-text');
      expect(await assets['caps']!.source.text()).toContain('Hello');
      return { blob: new Blob(['mp4']), videoCodec: 'avc', audioCodec: 'aac', spanCount: 1 };
    });
    const r = await executePipeline(pipeline, table(), {
      derivers: { transcribe: async () => CUES }, renderExec,
    });
    expect(renderExec).toHaveBeenCalledOnce();
    expect(r.videoCodec).toBe('avc');
  });

  it('transformImage runs its still plan and publishes the frame as an image artifact', async () => {
    const pipeline = compile([
      { id: 'gray', op: 'transformImage', source: 'logo', effects: [{ type: 'grayscale' }] },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'image', source: 'gray', place: { anchor: 'bottom-right', width: '20%' }, placementSource: 'user' }],
        output: { container: 'mp4', video: {}, audio: {} },
      },
    ]);
    const renderExec = vi.fn(async (p, assets: AssetTable) => {
      if (p.output.container === 'png') {
        // the transform step's still plan sees the source image
        expect(assets['logo']).toBeDefined();
        return { blob: new Blob(['gray-png'], { type: 'image/png' }), videoCodec: null, audioCodec: null, spanCount: 1 };
      }
      // the deliverable render sees the published artifact
      expect(assets['gray']!.kind).toBe('image');
      expect(await assets['gray']!.source.text()).toBe('gray-png');
      return { blob: new Blob(['mp4']), videoCodec: 'avc', audioCodec: 'aac', spanCount: 1 };
    });
    const r = await executePipeline(pipeline, table(), { renderExec });
    expect(renderExec).toHaveBeenCalledTimes(2);
    expect(await r.blob!.text()).toBe('mp4');
  });

  it('transformImage-terminal delivers its still plan output directly', async () => {
    const pipeline = compile([
      { id: 'gray', op: 'transformImage', source: 'logo', effects: [{ type: 'grayscale' }], format: 'jpeg' },
    ]);
    const renderExec = vi.fn(async (p) => {
      expect(p.output.container).toBe('jpeg');
      return { blob: new Blob(['gray-jpeg'], { type: 'image/jpeg' }), videoCodec: null, audioCodec: null, spanCount: 1 };
    });
    const r = await executePipeline(pipeline, table(), { renderExec });
    expect(await r.blob!.text()).toBe('gray-jpeg');
    expect(r.blob!.type).toBe('image/jpeg');
  });

  it('a missing deriver backend is an honest failure', async () => {
    const pipeline = compile([{ id: 'caps', op: 'transcribe', source: 'a' }]);
    await expect(executePipeline(pipeline, table(), {})).rejects.toThrow(/transcribe.*not available/);
  });

  it('step progress reports pruned-adjusted indices', async () => {
    const pipeline = compile([
      { id: 'caps', op: 'transcribe', source: 'a' },
      { id: 'caps_es', op: 'translate', source: 'caps', to: 'es' },
    ]);
    const seen: string[] = [];
    await executePipeline(pipeline, table(), {
      derivers: { transcribe: async () => CUES, translate: async (c) => c },
      onStep: (p) => seen.push(`${p.stepIndex}/${p.stepCount}:${p.stepId}`),
    });
    expect(seen).toEqual(['0/2:caps', '1/2:caps_es']);
  });
});

describe('pipelineRequirements() [G4]', () => {
  it('reports derivers on needed steps plus render kernels', async () => {
    const { pipelineRequirements } = await import('../src/pipeline-info');
    const pipeline = compile([
      { id: 'cut', op: 'removebg', source: 'logo' },      // a sink → delivers [G2 amendment]
      { id: 'caps', op: 'transcribe', source: 'a' },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'captions', source: 'caps' }],
        effects: [{ type: 'upscale' }, { type: 'denoise' }],
        output: { container: 'mp4', video: {}, audio: {} },
      },
    ]);
    const reqs = pipelineRequirements(pipeline);
    expect(reqs.map((r) => r.capability).sort()).toEqual(['denoise', 'removebg', 'transcribe', 'upscale']);
    expect(reqs.find((r) => r.capability === 'transcribe')!.params).toEqual({ model: 'base' });
    expect(reqs.find((r) => r.capability === 'upscale')!.params).toMatchObject({ model: 'auto', to: { w: 640, h: 360 } });
  });
});

describe('instantPipeline() [I1]', () => {
  it('qr alone is instant', () => {
    const pipeline = compile([{ id: 'code', op: 'qrcode', text: 'https://katana.video' }], {});
    expect(instantPipeline(pipeline)).toBe(true);
  });

  it('transformImage (pure filters) is instant', () => {
    const pipeline = compile([
      { id: 'gray', op: 'transformImage', source: 'logo', effects: [{ type: 'grayscale' }] },
    ]);
    expect(instantPipeline(pipeline)).toBe(true);
  });

  it('still renders are instant — photo filter and video frame grabs alike', () => {
    const photo = compile([{
      id: 'out', op: 'render',
      timeline: [{ type: 'clip', source: 'logo' }],
      effects: [{ type: 'sepia' }],
      output: { container: 'png', video: {} },
    }]);
    expect(instantPipeline(photo)).toBe(true);
    const frames = compile([0, 2, 4].map((t) => ({
      id: `f${t}`, op: 'render',
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', video: {}, at: t },
    })));
    expect(instantPipeline(frames)).toBe(true);
  });

  it('a span loop is never instant — video, audio, gif', () => {
    for (const container of ['mp4', 'gif'] as const) {
      const pipeline = compile([{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        output: { container, video: {}, ...(container === 'mp4' ? { audio: {} } : {}) },
      }]);
      expect(instantPipeline(pipeline), container).toBe(false);
    }
  });

  it('model-backed work is never instant', () => {
    const removebg = compile([{ id: 'cut', op: 'removebg', source: 'logo' }]);
    expect(instantPipeline(removebg)).toBe(false);
    const transcribe = compile([{ id: 'caps', op: 'transcribe', source: 'a' }]);
    expect(instantPipeline(transcribe)).toBe(false);
  });
});

describe('deriver progress plumbing', () => {
  it('forwards ctx.onProgress to onDeriverProgress', async () => {
    const pipeline = compile([{ id: 'caps', op: 'transcribe', source: 'a' }]);
    const seen: number[] = [];
    await executePipeline(pipeline, table(), {
      derivers: {
        async transcribe(_src, _params, ctx) {
          ctx.onProgress?.(0.25);
          ctx.onProgress?.(0.75);
          return CUES;
        },
      },
      onDeriverProgress: (f) => seen.push(f),
    });
    expect(seen).toEqual([0.25, 0.75]);
  });
});

describe('executePipeline(): sink output [docs/streaming-output-plan.md]', () => {
  const fakeSink = new WritableStream() as never;
  const sinkAwareExec = () => vi.fn(async (_plan: unknown, _assets: unknown, opts: { sink?: unknown }) => ({
    blob: opts.sink ? null : new Blob(['rendered']),
    videoCodec: 'avc', audioCodec: 'aac', spanCount: 1,
  }));

  it('routes the sink to the single render deliverable; result blob is null', async () => {
    const pipeline = compile([{
      id: 'out', op: 'render',
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'mp4', video: {}, audio: {} },
    }]);
    const exec = sinkAwareExec();
    const r = await executePipeline(pipeline, table(), { renderExec: exec as never, sink: fakeSink });
    expect(exec).toHaveBeenCalledOnce();
    expect((exec.mock.calls[0]![2] as { sink?: unknown }).sink).toBe(fakeSink);
    expect(r.blob).toBeNull();
    expect(r.outputs).toEqual([]);
    expect(r.videoCodec).toBe('avc');
  });

  it('non-deliverable renders (transformImage) never receive the sink', async () => {
    const pipeline = compile([
      { id: 'edited', op: 'transformImage', source: 'logo', effects: [{ type: 'grayscale' }] },
      {
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'a' }],
        overlays: [{ type: 'image', source: 'edited', place: { anchor: 'bottom-right', width: '20%' }, placementSource: 'user' }],
        output: { container: 'mp4', video: {}, audio: {} },
      },
    ]);
    const exec = sinkAwareExec();
    const r = await executePipeline(pipeline, table(), { renderExec: exec as never, sink: fakeSink });
    expect(exec).toHaveBeenCalledTimes(2);
    const sinks = exec.mock.calls.map((c) => (c[2] as { sink?: unknown }).sink);
    expect(sinks.filter(Boolean)).toEqual([fakeSink]); // exactly one — the deliverable
    expect(r.blob).toBeNull();
  });

  it('rejects a sink when the deliverable is not a muxed render', async () => {
    const caps = compile([{ id: 'caps', op: 'transcribe', source: 'a' }]);
    await expect(executePipeline(caps, table(), { sink: fakeSink, derivers: { transcribe: async () => CUES } }))
      .rejects.toThrow(/single muxed-container render/);

    const still = compile([{
      id: 'frame', op: 'render',
      timeline: [{ type: 'clip', source: 'a' }],
      output: { container: 'png', at: 1 },
    }]);
    await expect(executePipeline(still, table(), { sink: fakeSink, renderExec: sinkAwareExec() as never }))
      .rejects.toThrow(/single muxed-container render/);
  });

  it('rejects a sink on multi-deliverable pipelines', async () => {
    const two = compile([
      {
        id: 'v1', op: 'render', timeline: [{ type: 'clip', source: 'a' }],
        output: { container: 'mp4', video: {}, audio: {} },
      },
      {
        id: 'v2', op: 'render', timeline: [{ type: 'clip', source: 'a' }],
        output: { container: 'webm', video: {}, audio: {} },
      },
    ]);
    await expect(executePipeline(two, table(), { sink: fakeSink, renderExec: sinkAwareExec() as never }))
      .rejects.toThrow(/single muxed-container render/);
  });
});
