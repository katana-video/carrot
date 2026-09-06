/**
 * Stream-copy lane — pumps encoded packets from an input track straight into
 * the output's packet source. No decode, no GPU, no spans: [D1] eligibility
 * guarantees source time == output time for the whole job, so this runs once
 * per copied track, concurrently with any re-encoding lane's span loop.
 *
 * Mediabunny contract (verified against 1.50.3 types):
 * - EncodedPacketSink.packets() yields decode order; timestamps are
 *   presentation timestamps; B-frame reordering is the muxer's job.
 * - The first add() must carry the decoder config (codec description, e.g.
 *   avcC), obtained from the input track.
 */

import {
  EncodedPacketSink,
  type EncodedPacket, type EncodedVideoPacketSource, type EncodedAudioPacketSource,
} from 'mediabunny';
import type { CopyTrackDecl, Sec } from '../schema';
import type { AssetIO } from './assets';

const EPS = 1e-6;

interface PacketReceiver {
  add(packet: EncodedPacket, meta?: { decoderConfig?: unknown }): Promise<void>;
}

export interface CopyLaneCtx {
  io: AssetIO;
  signal: AbortSignal;
  onMediaTime?: (t: Sec) => void;
}

export async function runCopyLane(
  decl: CopyTrackDecl,
  kind: 'video' | 'audio',
  source: EncodedVideoPacketSource | EncodedAudioPacketSource,
  ctx: CopyLaneCtx,
): Promise<void> {
  const asset = ctx.io.get(decl.asset);
  const track = kind === 'video' ? asset.video : asset.audio;
  if (!track) throw new Error(`copy lane: asset '${asset.label}' has no ${kind} track`);
  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) throw new Error(`copy lane: no decoder config for '${asset.label}' ${kind}`);

  const sink = new EncodedPacketSink(track);
  const receiver = source as PacketReceiver;
  let first = true;
  for await (const packet of sink.packets()) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new DOMException('aborted', 'AbortError');
    // End truncation is audio-only (every audio packet is independently
    // decodable). Video eligibility pins end = full duration, and breaking on
    // presentation time mid-stream would be wrong under B-frame reordering.
    if (kind === 'audio' && packet.timestamp >= decl.end - EPS) break;
    await receiver.add(packet, first ? { decoderConfig } : undefined);
    first = false;
    ctx.onMediaTime?.(packet.timestamp);
  }
}
