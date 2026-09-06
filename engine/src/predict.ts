/**
 * Coarse output-size prediction for a compiled plan — the input frontends use
 * to decide WHEN to offer disk output (docs/streaming-output-plan.md). It is
 * a threshold signal, never shown to the user, so coarse is fine; the same
 * spirit as the upscaler's `(bitrate/8)*duration` gate. Thresholds themselves
 * live in the frontends (ask-UX policy, not engine mechanism).
 */
import type { CompiledPlan } from './schema';

/** Assumed fps for bits-per-pixel estimation (prediction only). */
const EST_FPS = 30;
/** Encoded bits per pixel per frame by quality tier (H.264-ish ballpark). */
const BPP: Record<string, number> = { low: 0.05, medium: 0.08, high: 0.12 };
const DEFAULT_AUDIO_BPS = 128_000;

export function predictOutputBytes(plan: CompiledPlan, inputBytes: number): number {
  if (plan.still) return 32 * 1024 * 1024; // stills are never sink candidates
  const duration = plan.spans.length ? plan.spans[plan.spans.length - 1]!.end : 0;

  // Both lanes copied = a remux: the input's own size is the best predictor.
  if (plan.strategy.video === 'copy' && plan.strategy.audio !== 'reencode') {
    return inputBytes;
  }

  let bytes = 0;
  if (plan.output.video) {
    if (plan.strategy.video === 'copy') {
      bytes += inputBytes * 0.9; // video dominates file size
    } else {
      const bps = plan.output.video.bitrate
        ?? plan.canvas.w * plan.canvas.h * EST_FPS * (BPP[plan.output.video.quality ?? 'medium'] ?? 0.08);
      bytes += (bps / 8) * duration;
    }
  }
  if (plan.output.audio && plan.strategy.audio !== 'none') {
    bytes += ((plan.output.audio.bitrate ?? DEFAULT_AUDIO_BPS) / 8) * duration;
  }
  return Math.round(bytes);
}
