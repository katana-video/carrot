/**
 * AssetIO — one Mediabunny Input per asset for the job's lifetime.
 * Per-span slot streams are range queries (`samples(start, end)`) into these,
 * never re-opens. Static images load once and cache as bitmaps.
 */

import {
  Input, BlobSource, ALL_FORMATS,
  VideoSampleSink, AudioSampleSink,
  type InputVideoTrack, type InputAudioTrack,
} from 'mediabunny';
import type { AssetId, AssetTable, Geometry } from '../schema';
import { loadStaticImage } from '../render/index';

export interface OpenAsset {
  id: AssetId;
  label: string;
  input: Input | null;              // null for image/timed-text assets
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  geometry: Geometry | null;        // display geometry (rotation baked)
  duration: number;
  bitmap: ImageBitmap | null;       // image assets only
  text: string | null;              // timed-text assets only (WebVTT source)
}

/** Fresh sink per slot stream — one asset may feed several concurrent slot
 * streams (same-source composition), and sinks own decoder state. */
export function videoSinkFor(a: OpenAsset): VideoSampleSink {
  if (!a.video) throw new Error(`asset '${a.label}' has no video track`);
  return new VideoSampleSink(a.video);
}
export function audioSinkFor(a: OpenAsset): AudioSampleSink {
  if (!a.audio) throw new Error(`asset '${a.label}' has no audio track`);
  return new AudioSampleSink(a.audio);
}

export class AssetIO {
  private constructor(readonly assets: Map<AssetId, OpenAsset>) {}

  static async open(table: AssetTable): Promise<AssetIO> {
    const assets = new Map<AssetId, OpenAsset>();
    await Promise.all(Object.entries(table).map(async ([id, decl]) => {
      const label = decl.label ?? id;
      if (decl.kind === 'image') {
        const bitmap = await loadStaticImage(decl.source);
        assets.set(id, {
          id, label, input: null, video: null, audio: null,
          geometry: { w: bitmap.width, h: bitmap.height }, duration: Infinity, bitmap, text: null,
        });
        return;
      }
      if (decl.kind === 'timed-text') {
        assets.set(id, {
          id, label, input: null, video: null, audio: null,
          geometry: null, duration: 0, bitmap: null, text: await decl.source.text(),
        });
        return;
      }
      const input = new Input({ source: new BlobSource(decl.source), formats: ALL_FORMATS });
      const video = decl.kind === 'video' ? await input.getPrimaryVideoTrack() : null;
      const audio = await input.getPrimaryAudioTrack();
      if (decl.kind === 'video' && !video) throw new Error(`asset '${label}': no video track`);
      if (decl.kind === 'audio' && !audio) throw new Error(`asset '${label}': no audio track`);
      assets.set(id, {
        id, label, input, video, audio,
        geometry: video ? { w: video.displayWidth, h: video.displayHeight } : null,
        duration: await input.computeDuration(),
        bitmap: null, text: null,
      });
    }));
    return new AssetIO(assets);
  }

  get(id: AssetId): OpenAsset {
    const a = this.assets.get(id);
    if (!a) throw new Error(`unknown asset '${id}'`);
    return a;
  }
}
