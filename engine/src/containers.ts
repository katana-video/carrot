/**
 * Container format factories — the executor's output negotiation gets its
 * muxers here. The codec preference/copy-legality TABLES live in
 * codec-tables.ts (pure, no mediabunny) so the main-thread planner can gate
 * stream copy [D1] without bundling the muxers; test/codec-tables.test.ts
 * pins the two layers to identical answers.
 */

import {
  Mp4OutputFormat, WebMOutputFormat, MkvOutputFormat, Mp3OutputFormat, WavOutputFormat, OggOutputFormat,
  type OutputFormat,
} from 'mediabunny';
import type { ContainerId } from './codec-tables';

export { VIDEO_PREFS, AUDIO_PREFS, canCopyCodec, type ContainerId } from './codec-tables';

export const CONTAINERS: Record<ContainerId, () => OutputFormat> = {
  mp4: () => new Mp4OutputFormat(),
  webm: () => new WebMOutputFormat(),
  mkv: () => new MkvOutputFormat(),
  mp3: () => new Mp3OutputFormat(),
  wav: () => new WavOutputFormat(),
  ogg: () => new OggOutputFormat(),
};
