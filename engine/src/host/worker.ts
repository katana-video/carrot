/**
 * Bare engine worker entry — no model backends. Single-render plans execute;
 * pipelines with model-backed steps fail honestly ("not available on this
 * host"). Apps with tier-1 capabilities author their OWN entry:
 *
 *   import { createWorkerHost } from '@katana-video/carrot';
 *   import { registerKernels, derivers } from './capabilities';
 *   createWorkerHost({ init: registerKernels, derivers });
 *
 * Consume via Vite:
 *   import EngineWorker from '@katana-video/carrot/src/host/worker.ts?worker';
 */
import { createWorkerHost } from './workerHost';

createWorkerHost();
