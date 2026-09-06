/**
 * Page entry registering the PUBLIC backends for the tier-1 harness cases —
 * exactly what an app's worker entry does, minus the worker. Everything here
 * comes from @katana-video/carrot-backends; host-private kernels (omni's
 * upscale) are not part of the public harness and their cases skip.
 * Publishes the derivers through window so harness.ts needs no static import.
 */
import { registerDenoise } from '@katana-video/carrot-backends/denoise';
import { removebg } from '@katana-video/carrot-backends/removebg';
import { transcribe } from '@katana-video/carrot-backends/whisper';
import { translate } from '@katana-video/carrot-backends/translate';

registerDenoise();
(window as { __tier1Derivers?: unknown }).__tier1Derivers = { transcribe, translate, removebg };
