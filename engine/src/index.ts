/**
 * @katana-video/carrot — browser-native media runtime engine.
 *
 * Layers: JobGraph (IR) → planner → CompiledPlan (spans) → executor → output.
 * See src/schema.ts for the contract and decision log; docs/design.md in the
 * repo for the full design, docs/ir-spec.md for the document format.
 */

export * from './schema';
export * from './nodes/streams';
export * from './nodes/mergeSlots';
export * from './nodes/audio';
export * from './render/index';
export * from './executor/execute';
export * from './executor/pipeline';
export * from './pipeline-info';
export * from './executor/timedtext';
export { parseVtt } from './executor/vtt';
export type { Cue, CueWord } from './executor/vtt';
export { kernelVideoSink, kernelAudioSink, createVideoKernel, createAudioKernel, resolveBackend } from './executor/kernels';
export * from './codec-tables';
export * from './predict';
export * from './loudness';
export * from './probe';
export * from './probe-deep';
export * from './probe-audio-window';
export * from './host/client';
export * from './host/workerHost';
export * from './host/protocol';
export {
  IR_VERSION, irDocumentSchema, irJsonSchema,
  timeScalarSchema, spaceScalarSchema, volumeSchema, rangeSchema, placeSchema,
  effectSchema, layerSchema, clipSchema, compositionSchema, transitionSchema,
  timelineItemSchema, overlaySchema, outputSchema, renderOpSchema, assetDeclSchema,
  transcribeOpSchema, translateOpSchema, removebgOpSchema, transformImageOpSchema,
  qrcodeOpSchema, operationSchema,
} from './ir/document';
export type {
  TimeScalar, SpaceScalar, Volume, Range, Place, Effect,
  Clip, Composition, Transition, TimelineItem, Overlay, Output, RenderOp, IrDocument,
  TranscribeOp, TranslateOp, RemovebgOp, TransformImageOp, QrcodeOp, Operation, DeriverOp,
} from './ir/document';
export type { Layer as IrLayer, AssetDecl as IrAssetDecl } from './ir/document';
export { LOOKS, expandLooks } from './ir/looks';
export type { LookName } from './ir/looks';
export * from './ir/errors';
export * from './ir/facts';
export * from './ir/scalars';
export * from './ir/normalize';
export * from './ir/place';
export * from './ir/plan';
