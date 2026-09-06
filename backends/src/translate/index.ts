/**
 * Translate deriver — `@katana-video/carrot-backends/translate`.
 *
 * The engine's `translate` step [L]: cue text is batched (~900 chars) and
 * translated with OPUS-MT via transformers.js (`Xenova/opus-mt-<src>-<tgt>`
 * from the Hugging Face hub; exotic pairs pivot through English [L3]),
 * timings preserved, word timings dropped [L2]. transformers.js is an
 * optional peer, imported on first use.
 */
import type { Cue, DeriverBackends } from '@katana-video/carrot';
import { applyTransformersWeightsBase } from '../weights';

export {
  TRANSLATE_LANGUAGES, resolveTranslationRoute, opusMtModelId, hasDirectOpusPair,
  type TranslateLanguageCode, type TranslationPair, type TranslationRoute,
} from './route';
export { translateTranscriptSegments, batchSegmentTexts, type TranslationModel } from './translateSegments';
export { opusMtModel, type TranslateDevice } from './opus';

/** The `translate` deriver: pass in `createWorkerHost({ derivers: { translate } })`. */
export const translate: NonNullable<DeriverBackends['translate']> = async (cues, params, ctx) => {
  await applyTransformersWeightsBase();
  const [{ translateTranscriptSegments }, { opusMtModel }] = await Promise.all([
    import('./translateSegments'),
    import('./opus'),
  ]);
  type Lang = import('./route').TranslateLanguageCode;
  const segments = cues.map((c, i) => ({
    id: i + 1, text: c.text, start: c.start, end: c.end,
    words: c.words.map((w) => ({ text: w.text, start: w.start, end: w.end })),
  }));
  const out = await translateTranscriptSegments(segments, {
    sourceLanguage: (params.from ?? 'en') as Lang,
    targetLanguage: params.to as Lang,
    ...(ctx.onProgress ? { onProgress: (done: number, total: number) => ctx.onProgress!(total ? done / total : 1) } : {}),
  }, opusMtModel('wasm', ctx.onModelProgress));
  // [L2] enforced engine-side too: translated cues carry no word timings
  return out.map((s): Cue => ({ start: s.start, end: s.end, text: s.text, words: [], wordTiming: false }));
};
