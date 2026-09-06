// Tier-1 [L] translation routing — from the frontend's translate/route.ts +
// languages.ts. Direct pair when available, else pivot through English [L3].
export type TranslateLanguageCode =
  | 'en' | 'es' | 'fr' | 'de' | 'pt' | 'it' | 'ja' | 'ko' | 'zh' | 'ar' | 'hi' | 'ru'

export const TRANSLATE_LANGUAGES: Record<TranslateLanguageCode, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic',
  hi: 'Hindi', ru: 'Russian',
}

export interface TranslationPair {
  source: TranslateLanguageCode
  target: TranslateLanguageCode
  modelId: string
}

export interface TranslationRoute {
  pairs: TranslationPair[]
  usesPivot: boolean
}

const PIVOT: TranslateLanguageCode = 'en'

const DIRECT_PAIRS = new Set<string>([
  'en-es', 'es-en', 'en-fr', 'fr-en', 'en-de', 'de-en', 'en-pt', 'pt-en',
  'en-it', 'it-en', 'en-ja', 'ja-en', 'en-ko', 'ko-en', 'en-zh', 'zh-en',
  'en-ar', 'ar-en', 'en-hi', 'hi-en', 'en-ru', 'ru-en',
  'es-fr', 'fr-es', 'es-de', 'de-es', 'fr-de', 'de-fr',
])

export function pairKey(source: TranslateLanguageCode, target: TranslateLanguageCode): string {
  return `${source}-${target}`
}

export function opusMtModelId(source: TranslateLanguageCode, target: TranslateLanguageCode): string {
  return `Xenova/opus-mt-${source}-${target}`
}

export function hasDirectOpusPair(source: TranslateLanguageCode, target: TranslateLanguageCode): boolean {
  return source === target || DIRECT_PAIRS.has(pairKey(source, target))
}

function pair(source: TranslateLanguageCode, target: TranslateLanguageCode): TranslationPair {
  return { source, target, modelId: opusMtModelId(source, target) }
}

export function resolveTranslationRoute(source: TranslateLanguageCode, target: TranslateLanguageCode): TranslationRoute {
  if (source === target) return { pairs: [], usesPivot: false }
  if (hasDirectOpusPair(source, target)) return { pairs: [pair(source, target)], usesPivot: false }
  if (!hasDirectOpusPair(source, PIVOT) || !hasDirectOpusPair(PIVOT, target)) {
    throw new Error(`No browser translation route from ${source} to ${target}`)
  }
  return { pairs: [pair(source, PIVOT), pair(PIVOT, target)], usesPivot: true }
}
