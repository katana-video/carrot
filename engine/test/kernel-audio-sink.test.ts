/**
 * kernelAudioSink resource hygiene: every emitted sample must be closed
 * after the inner add (the encoder copies on add). The leak this pins
 * against: one unclosed AudioSample per emission — long files exhaust the
 * platform audio-buffer pool and the pipeline wedges mid-run.
 */
import { describe, expect, it } from 'vitest';
import type { AudioSample } from 'mediabunny';
import { kernelAudioSink } from '../src/executor/kernels';
import { planarSample } from '../src/nodes/audio';

const identity = {
  process: (x: Float32Array) => x,
  flush: () => new Float32Array(0),
};

describe('kernelAudioSink', () => {
  it('closes the input sample AND the emitted sample after add', async () => {
    const added: AudioSample[] = [];
    const closedOnAdd: boolean[] = [];
    const inner = {
      add(s: AudioSample) {
        added.push(s);
        // during add the sample must still be live (encoder reads it here)
        expect(() => s.allocationSize({ planeIndex: 0, format: 'f32-planar' })).not.toThrow();
        closedOnAdd.push(false);
      },
    };
    const sink = kernelAudioSink(inner, identity, { rate: 48000, channels: 2 });

    const input = planarSample([new Float32Array(480), new Float32Array(480)], 48000, 0);
    await sink.add(input);
    await sink.flush();

    expect(added).toHaveLength(1);
    // after add returns, both the input and the emitted sample are closed
    expect(() => input.allocationSize({ planeIndex: 0, format: 'f32-planar' })).toThrow();
    expect(() => added[0]!.allocationSize({ planeIndex: 0, format: 'f32-planar' })).toThrow();
  });
});
