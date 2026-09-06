// The playground's engine worker: the engine host + every public backend.
// This is the "compose your worker" pattern from docs/backends.md.
import { createWorkerHost } from '@katana-video/carrot';
import { registerDenoise } from '@katana-video/carrot-backends/denoise';
import { removebg } from '@katana-video/carrot-backends/removebg';
import { transcribe } from '@katana-video/carrot-backends/whisper';
import { translate } from '@katana-video/carrot-backends/translate';

createWorkerHost({
  init: () => registerDenoise(),
  derivers: { transcribe, translate, removebg },
});
