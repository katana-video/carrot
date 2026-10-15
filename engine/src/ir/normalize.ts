/**
 * normalize() — structural, fact-free validation and canonicalization [§12].
 * Total and deterministic; equality/goldens are defined on its output [A8].
 *
 * v0.2 [G1]: documents are operation DAGs. normalize checks the namespace
 * (assets ∪ operations, one namespace [P2a]), reference resolution, and
 * acyclicity; kind checks are preflight's job (facts-dependent, in lower).
 */

import { irDocumentSchema, type Clip, type Effect, type IrDocument, type Operation, type RenderOp } from './document';
import { err, type IrError } from './errors';

export interface NormalizeResult {
  doc: IrDocument | null;
  errors: IrError[];
  /** Operation indices in topological (execution) order; authored order is
   * preserved in the document (the LAST authored op is the deliverable [G2]). */
  topoOrder: number[];
}

/** Every reference an operation makes to other ids (assets or operations). */
export function opReferences(op: Operation): string[] {
  if (op.op === 'qrcode') return []; // the one source-less (generator) op
  if (op.op !== 'render') return [op.source];
  const refs: string[] = [];
  for (const item of op.timeline) {
    if (item.type === 'clip') refs.push(item.source);
    else if (item.type === 'composition') for (const l of item.layers) refs.push(l.source);
  }
  for (const ov of op.overlays ?? []) refs.push(ov.source);
  if (op.output.audio?.from) refs.push(op.output.audio.from);
  if (op.output.subtitles) refs.push(op.output.subtitles.from);
  return refs;
}

export function normalize(input: unknown): NormalizeResult {
  const errors: IrError[] = [];

  const parsed = irDocumentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(err('schema-invalid', issue.path.join('.'), issue.message));
    }
    return { doc: null, errors, topoOrder: [] };
  }
  // structuredClone: normalization must not mutate the caller's document
  const doc = structuredClone(parsed.data);
  const assetIds = new Set(Object.keys(doc.assets));

  // [P2a] one namespace: assets and operations, no duplicates anywhere
  const opIndexById = new Map<string, number>();
  doc.operations.forEach((op, oi) => {
    if (assetIds.has(op.id)) {
      errors.push(err('id-collision', `operations[${oi}].id`, `operation id '${op.id}' collides with an asset id`));
    } else if (opIndexById.has(op.id)) {
      errors.push(err('id-collision', `operations[${oi}].id`, `duplicate operation id '${op.id}'`));
    }
    opIndexById.set(op.id, oi);
  });

  const known = (base: string) => assetIds.has(base) || opIndexById.has(base);

  doc.operations.forEach((op, oi) => {
    const opPath = `operations[${oi}]`;

    const checkRef = (ref: string, path: string) => {
      const [base, port] = ref.split('.');
      if (!known(base!)) {
        errors.push(err('unknown-reference', path, `'${ref}' names no asset or operation`));
      } else if (port !== undefined) {
        // no operation type declares named ports yet [P2]
        errors.push(err('unknown-reference', path, `'${ref}': no operation declares a port '${port}'`));
      }
    };

    if (op.op !== 'render') {
      if (op.op !== 'qrcode') checkRef(op.source, `${opPath}.source`);
      return;
    }

    // [X1] transitions between two slots
    op.timeline.forEach((item, ti) => {
      const path = `${opPath}.timeline[${ti}]`;
      if (item.type === 'transition') {
        const prev = op.timeline[ti - 1];
        const next = op.timeline[ti + 1];
        if (!prev || !next || prev.type === 'transition' || next.type === 'transition') {
          errors.push(err('transition-placement', path, 'a transition must sit between two clips/compositions'));
        }
      } else if (item.type === 'clip') {
        checkRef(item.source, `${path}.source`);
        item.effects?.forEach((fx, fi) => checkEffect(fx, `${path}.effects[${fi}]`, false, errors));
      } else {
        // composition-level effects with multiple visual layers: the composed-
        // slot semantics [E1] aren't implemented yet — honest error, not wrong output
        const visualLayers = item.layers.filter((l) => l.type !== 'audio').length;
        if (item.effects?.length && visualLayers > 1) {
          errors.push(err('unsupported-in-v01', `${path}.effects`,
            'composition-level effects with multiple visual layers are not yet supported'));
        }
        item.effects?.forEach((fx, fi) => checkEffect(fx, `${path}.effects[${fi}]`, false, errors));
        item.layers.forEach((layer, li) => {
          const lp = `${path}.layers[${li}]`;
          checkRef(layer.source, `${lp}.source`);
          if (layer.type !== 'audio') layer.effects?.forEach((fx, fi) => checkEffect(fx, `${lp}.effects[${fi}]`, false, errors));
          // a pad's color fills the canvas behind the BASE; a non-base layer
          // has no bars of its own to fill (it sits on top of other pixels)
          if (li > 0 && layer.type !== 'audio') layer.effects?.forEach((fx, fi) => {
            if (fx.type === 'pad' && fx.color !== undefined) {
              errors.push(err('unsupported-in-v01', `${lp}.effects[${fi}].color`,
                'pad colors apply to the base layer only; non-base layers pad transparent'));
            }
          });
          // [G2] non-base visual layers require an anchor
          if (li > 0 && (layer.type === 'video' || layer.type === 'image') && !layer.place?.anchor) {
            errors.push(err('missing-place', lp, `non-base ${layer.type} layer requires place.anchor [G2]`));
          }
        });
      }
    });

    op.overlays?.forEach((ov, vi) => {
      const path = `${opPath}.overlays[${vi}]`;
      checkRef(ov.source, `${path}.source`);
      if ('to' in ov && ov.to !== undefined && ov.duration !== undefined) {
        errors.push(err('window-invalid', path, "specify 'to' or 'duration', not both"));
      }
    });

    // [D8] soft subtitles: only video containers can carry a subtitle track
    if (op.output.subtitles) {
      checkRef(op.output.subtitles.from, `${opPath}.output.subtitles.from`);
      if (!['mp4', 'webm', 'mkv'].includes(op.output.container)) {
        errors.push(err('field-not-applicable', `${opPath}.output.subtitles`,
          `container '${op.output.container}' cannot carry a subtitle track [D8]`));
      }
    }
    if (op.output.audio?.from) checkRef(op.output.audio.from, `${opPath}.output.audio.from`);

    // [D7]/[D9] pixel-only outputs: single-frame extraction and animated gif
    const isImageOutput = op.output.container === 'png' || op.output.container === 'jpeg';
    const isGifOutput = op.output.container === 'gif';
    if (isImageOutput || isGifOutput) {
      const tag = isGifOutput ? '[D9]' : '[D7]';
      if (op.output.audio) {
        errors.push(err('field-not-applicable', `${opPath}.output.audio`, `${op.output.container} outputs carry no audio ${tag}`));
      }
      // Pixel-only containers imply the video track: requiring a literal
      // `video: {}` (because omitted video = audio-only [D2]) is a wart no
      // author-side rule should have to teach — normalize supplies it.
      if (!op.output.video) op.output.video = {};
      if (op.output.video?.codec || op.output.video?.bitrate) {
        errors.push(err('field-not-applicable', `${opPath}.output.video`, `${op.output.container} outputs take no codec/bitrate ${tag}`));
      }
    }
    if (!isImageOutput && op.output.at !== undefined) {
      errors.push(err('field-not-applicable', `${opPath}.output.at`, "'at' applies to image outputs only [D7]"));
    }

    // top-level effects: model-backed kernels are legal here (and only here);
    // at most one of each [U1, H1]
    let sawUpscale = false, sawDenoise = false, sawEnhance = false;
    op.effects?.forEach((fx, fi) => {
      checkEffect(fx, `${opPath}.effects[${fi}]`, true, errors);
      if (fx.type === 'upscale') {
        if (sawUpscale) errors.push(err('unsupported-in-v01', `${opPath}.effects[${fi}]`, 'multiple upscale effects are not supported'));
        sawUpscale = true;
      }
      if (fx.type === 'denoise') {
        if (sawDenoise) errors.push(err('unsupported-in-v01', `${opPath}.effects[${fi}]`, 'multiple denoise effects are not supported'));
        sawDenoise = true;
      }
      if (fx.type === 'enhance') {
        if (sawEnhance) errors.push(err('unsupported-in-v01', `${opPath}.effects[${fi}]`, 'multiple enhance effects are not supported'));
        sawEnhance = true;
      }
    });
    if (sawEnhance && sawDenoise) {
      errors.push(err('unsupported-in-v01', `${opPath}.effects`, 'enhance already removes noise — use enhance OR denoise, not both'));
    }

    canonicalize(op);
  });

  // [G1] acyclicity + topological order over the operation graph
  const topoOrder: number[] = [];
  if (!errors.some((e) => e.code === 'id-collision' || e.code === 'unknown-reference')) {
    const state = new Array<0 | 1 | 2>(doc.operations.length).fill(0); // 0 unvisited, 1 in-stack, 2 done
    let cyclic = false;
    const visit = (oi: number): void => {
      if (state[oi] === 2 || cyclic) return;
      if (state[oi] === 1) {
        cyclic = true;
        errors.push(err('reference-cycle', `operations[${oi}]`,
          `operation '${doc.operations[oi]!.id}' participates in a reference cycle [G1]`));
        return;
      }
      state[oi] = 1;
      for (const ref of opReferences(doc.operations[oi]!)) {
        const dep = opIndexById.get(ref.split('.')[0]!);
        if (dep !== undefined) visit(dep);
      }
      state[oi] = 2;
      topoOrder.push(oi);
    };
    doc.operations.forEach((_, oi) => visit(oi));
  }

  return { doc, errors, topoOrder };
}

function checkEffect(fx: Effect, path: string, topLevel: boolean, errors: IrError[]) {
  if ((fx.type === 'upscale' || fx.type === 'denoise' || fx.type === 'enhance') && !topLevel) {
    errors.push(err('unsupported-in-v01', path,
      `'${fx.type}' is only supported at the render top level in v0.2 (applies to the composed output) [${fx.type === 'upscale' ? 'U1' : 'H1'}]`));
  }
}

/** [C6] one-layer video composition with no composition-only features → clip. */
function canonicalize(op: RenderOp): void {
  op.timeline = op.timeline.map((item) => {
    if (item.type !== 'composition' || item.layers.length !== 1 || item.duration !== undefined) return item;
    const layer = item.layers[0]!;
    if (layer.type !== 'video') return item;
    if (layer.place || layer.opacity !== undefined || layer.at !== undefined || layer.audio !== undefined) return item;
    const clip: Clip = { type: 'clip', source: layer.source };
    if (layer.range) clip.range = layer.range;
    if (layer.volume !== undefined) clip.volume = layer.volume;
    const effects = [...(layer.effects ?? []), ...(item.effects ?? [])];
    if (effects.length) clip.effects = effects;
    return clip;
  });
}
