/**
 * Worked example — the schema exercised end to end, as data.
 *
 * Request (the founding example from the design discussions):
 *   "Concatenate these two videos, replace the audio with this music track,
 *    and crop the result to a square."
 *
 * Inputs for concreteness:
 *   v1: 1920x1080 video, 20.0s, has audio (ignored — audio is output wiring)
 *   v2: 1280x720  video, 10.0s
 *   music: audio file, 35.0s (longer than output — planner truncates)
 *
 * This file is executable documentation: `exampleJob` is what the NL compiler
 * (or a landing page) emits; `expectedPlan` is what the planner MUST produce
 * from it. It becomes the planner's first golden test verbatim.
 */

import type { CompiledPlan, JobGraph } from './schema';
import { SCHEMA_VERSION } from './schema';

declare const v1Blob: Blob, v2Blob: Blob, musicBlob: Blob; // supplied by host/test

// ---------------------------------------------------------------------------
// The IR: what clients author
// ---------------------------------------------------------------------------

export const exampleJob: JobGraph = {
  schemaVersion: SCHEMA_VERSION,
  assets: {
    v1: { kind: 'video', source: v1Blob, label: 'intro.mp4' },
    v2: { kind: 'video', source: v2Blob, label: 'main.mp4' },
    music: { kind: 'audio', source: musicBlob, label: 'bgm.mp3' },
  },
  ops: [
    // concat is temporal: it defines timeline structure, not pixels
    { id: 'cat', op: 'concat', inputs: [{ asset: 'v1', track: 'video' }, { asset: 'v2', track: 'video' }] },
    // crop is a spec-edit on the concatenated flow; center square by default
    { id: 'sq', op: 'crop', params: { aspect: '1:1' }, inputs: [{ node: 'cat' }] },
  ],
  output: {
    container: 'mp4',
    video: { from: { node: 'sq' }, codec: 'avc', quality: 'medium' },
    // "swap the audio" is not an op — it's output wiring:
    audio: { from: { asset: 'music', track: 'audio' } },
  },
};

// ---------------------------------------------------------------------------
// What the planner must produce (golden expectation)
//
// Geometry inference walk:
//   concat inputs 1920x1080 and 1280x720 → canvas policy 'largest wins'
//     → canvas 1920x1080; v2 letterboxed/scaled per policy (scale-to-fit
//     with pillarbox: 1280x720 → 1920x1080 fills exactly, ratio matches)
//   crop 1:1 on 1920x1080 → 1080x1080 centered → srcRect x=420
//   → output canvas: 1080x1080 (per-output constant, both spans)
//
// Span flattening walk:
//   concat → two spans; music truncated to output duration (30s), rebased 0
//   (its span structure follows the output timeline, not the video sources,
//   so it appears in BOTH spans' audio bindings with contiguous ranges)
// ---------------------------------------------------------------------------

export const expectedPlan: CompiledPlan = {
  schemaVersion: SCHEMA_VERSION,
  canvas: { w: 1080, h: 1080 },
  audioFormat: { rate: 48000, channels: 2 },
  output: exampleJob.output,
  strategy: { video: 'reencode', audio: 'reencode' },
  spans: [
    {
      start: 0,
      end: 20,
      video: {
        bindings: [{ slot: 0, asset: 'v1', track: 'video', sourceStart: 0, sourceEnd: 20, offset: 0 }],
        composite: {
          canvas: { w: 1080, h: 1080 },
          layers: [{
            input: 0,
            // crop 1:1 fused into the layer: sample the center 1080x1080 of v1
            srcRect: { x: 420, y: 0, w: 1080, h: 1080 },
            transform: [1, 0, 0, 0, 1, 0],
            opacity: 1,
            blend: 'over',
          }],
        },
      },
      audio: {
        bindings: [{ slot: 0, asset: 'music', track: 'audio', sourceStart: 0, sourceEnd: 20, offset: 0 }],
        mode: 'single',
      },
    },
    {
      start: 20,
      end: 30,
      video: {
        bindings: [{ slot: 0, asset: 'v2', track: 'video', sourceStart: 0, sourceEnd: 10, offset: 20 }],
        composite: {
          canvas: { w: 1080, h: 1080 },
          layers: [{
            input: 0,
            // same crop, v2's geometry: 1280x720 scaled to 1920x1080 first is
            // FUSED AWAY — planner samples v2 directly: center square of the
            // 720-high frame is 720x720 at x=280, scaled 1.5x to 1080x1080
            srcRect: { x: 280, y: 0, w: 720, h: 720 },
            transform: [1.5, 0, 0, 0, 1.5, 0],
            opacity: 1,
            blend: 'over',
          }],
        },
      },
      audio: {
        bindings: [{ slot: 0, asset: 'music', track: 'audio', sourceStart: 20, sourceEnd: 30, offset: 0 }],
        mode: 'single',
      },
    },
  ],
};
