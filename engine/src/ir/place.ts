/**
 * Placement resolution [G1–G3] — shared between the renderer (lower.ts) and
 * the app's interactive placement widgets, so what the user drags is
 * pixel-identical to what the render produces.
 *
 * placeBox: Place → pixel rect (the renderer's semantics, moved verbatim).
 * rectToPlace: pixel rect → Place — the widget's write-back. Anchor-canonical:
 * snaps to the nearest 9-point anchor and stores offsets from it, so
 * placements survive upstream geometry edits ("bottom-right, nudged 20px in"
 * stays bottom-right when the canvas changes).
 */
import type { Geometry } from '../schema';
import type { Effect, Place } from './document';
import { resolveSpace } from './scalars';

type CropEffect = Extract<Effect, { type: 'crop' }>;

export interface PlacedRect { x: number; y: number; w: number; h: number }

export const ANCHOR: Record<string, [number, number]> = {
  'top-left': [0, 0], top: [0.5, 0], 'top-right': [1, 0],
  left: [0, 0.5], center: [0.5, 0.5], right: [1, 0.5],
  'bottom-left': [0, 1], bottom: [0.5, 1], 'bottom-right': [1, 1],
};

export function placeBox(place: Place, natural: Geometry, canvas: Geometry): PlacedRect {
  let w = place.width !== undefined ? resolveSpace(place.width, canvas.w) : undefined;
  let h = place.height !== undefined ? resolveSpace(place.height, canvas.h) : undefined;
  if (w === undefined && h === undefined) {
    // intrinsic, contained if oversized
    const k = Math.min(1, canvas.w / natural.w, canvas.h / natural.h);
    w = natural.w * k; h = natural.h * k;
  } else if (w === undefined) w = h! * (natural.w / natural.h);
  else if (h === undefined) h = w * (natural.h / natural.w);

  if (place.fit === 'contain' && place.width !== undefined && place.height !== undefined) {
    const k = Math.min(w / natural.w, h! / natural.h);
    w = natural.w * k; h = natural.h * k;
  }
  // 'cover' and 'fill' both map the source into the full box in v0.1
  // (cover-with-crop is a later refinement; documented in FINDINGS)

  const [ax, ay] = ANCHOR[place.anchor]!;
  const margin = place.margin !== undefined ? resolveSpace(place.margin, Math.min(canvas.w, canvas.h)) : 0;
  let x = (canvas.w - w) * ax;
  let y = (canvas.h - h!) * ay;
  if (ax === 0) x += margin; if (ax === 1) x -= margin;
  if (ay === 0) y += margin; if (ay === 1) y -= margin;
  if (place.x !== undefined) x += resolveSpace(place.x, canvas.w);
  if (place.y !== undefined) y += resolveSpace(place.y, canvas.h);
  return { x, y, w, h: h! };
}

/**
 * A crop effect's kept region in pixels, against the geometry the crop
 * applies to (the renderer's semantics, moved from lower.ts — shared with
 * the app's crop widget). No bounds validation here; lower does that.
 */
export function cropBox(fx: CropEffect, geom: Geometry): PlacedRect {
  if ('region' in fx) {
    return {
      x: fx.region.x !== undefined ? resolveSpace(fx.region.x, geom.w) : 0,
      y: fx.region.y !== undefined ? resolveSpace(fx.region.y, geom.h) : 0,
      w: resolveSpace(fx.region.width, geom.w),
      h: resolveSpace(fx.region.height, geom.h),
    };
  }
  const [aw, ah] = fx.aspect.split(':').map(Number) as [number, number];
  const a = aw / ah;
  const rw = Math.min(geom.w, geom.h * a);
  const rh = rw / a;
  const [ax, ay] = ANCHOR[fx.anchor ?? 'center']!;
  return { x: (geom.w - rw) * ax, y: (geom.h - rh) * ay, w: rw, h: rh };
}

/**
 * Inverse of placeBox for widget write-back. Picks the 9-point anchor whose
 * natural position is nearest the rect, then expresses the remainder as x/y
 * offsets (omitted when < 1px). Size is written as `width` only (height
 * derives from the source aspect). Round-trips through placeBox to < 1px.
 */
export function rectToPlace(rect: PlacedRect, canvas: Geometry): Place {
  let best: Place['anchor'] = 'top-left';
  let bestD = Infinity;
  for (const [name, [ax, ay]] of Object.entries(ANCHOR)) {
    const nx = (canvas.w - rect.w) * ax;
    const ny = (canvas.h - rect.h) * ay;
    const d = (rect.x - nx) ** 2 + (rect.y - ny) ** 2;
    if (d < bestD) { bestD = d; best = name as Place['anchor']; }
  }
  const [ax, ay] = ANCHOR[best]!;
  const dx = Math.round(rect.x - (canvas.w - rect.w) * ax);
  const dy = Math.round(rect.y - (canvas.h - rect.h) * ay);
  const place: Place = { anchor: best, width: Math.round(rect.w) };
  if (dx !== 0) place.x = dx;
  if (dy !== 0) place.y = dy;
  return place;
}
