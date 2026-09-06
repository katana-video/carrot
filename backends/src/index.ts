/**
 * @katana-video/carrot-backends — model-backed backends for Carrot 🥕.
 *
 * Nothing here loads a model. Each backend is its own subpath import and
 * registers itself against the engine's contracts; import only what you use:
 *
 *   import { createWorkerHost } from '@katana-video/carrot';
 *   import { registerDenoise } from '@katana-video/carrot-backends/denoise';
 *   import { removebg }        from '@katana-video/carrot-backends/removebg';
 *   import { transcribe }      from '@katana-video/carrot-backends/whisper';
 *   import { translate }       from '@katana-video/carrot-backends/translate';
 *
 *   createWorkerHost({
 *     init: () => registerDenoise(),
 *     derivers: { transcribe, translate, removebg },
 *   });
 *
 * The heavy runtimes (transformers.js, web-bg-removal) are optional peer
 * dependencies, dynamic-imported inside the module that needs them.
 * `configureWeights` (from './weights') points every backend at a mirror.
 */
export { configureWeights, weightsBaseUrl, type WeightsConfig } from './weights';
