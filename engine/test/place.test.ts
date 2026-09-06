import { describe, expect, it } from 'vitest';
import { placeBox, rectToPlace } from '../src/ir/place';

const CANVAS = { w: 1920, h: 1080 };
const LOGO = { w: 400, h: 160 };

describe('rectToPlace ↔ placeBox round-trip', () => {
  it('anchor positions round-trip exactly', () => {
    for (const anchor of ['top-left', 'center', 'bottom-right', 'bottom', 'right'] as const) {
      const rect = placeBox({ anchor, width: 300 }, LOGO, CANVAS);
      const place = rectToPlace(rect, CANVAS);
      expect(place.anchor).toBe(anchor);
      const back = placeBox(place, LOGO, CANVAS);
      expect(Math.abs(back.x - rect.x)).toBeLessThan(1);
      expect(Math.abs(back.y - rect.y)).toBeLessThan(1);
      expect(Math.abs(back.w - rect.w)).toBeLessThan(1);
    }
  });

  it('offset placements keep the nearest anchor and round-trip < 1px', () => {
    // dragged 30px in from bottom-right
    const rect = { x: 1920 - 300 - 30, y: 1080 - 120 - 30, w: 300, h: 120 };
    const place = rectToPlace(rect, CANVAS);
    expect(place.anchor).toBe('bottom-right');
    expect(place.x).toBe(-30);
    expect(place.y).toBe(-30);
    const back = placeBox(place, LOGO, CANVAS);
    expect(Math.abs(back.x - rect.x)).toBeLessThan(1);
    expect(Math.abs(back.y - rect.y)).toBeLessThan(1);
  });

  it('a centered-ish drag snaps to center with offsets', () => {
    const rect = { x: (1920 - 400) / 2 + 12, y: (1080 - 160) / 2 - 8, w: 400, h: 160 };
    const place = rectToPlace(rect, CANVAS);
    expect(place.anchor).toBe('center');
    const back = placeBox(place, LOGO, CANVAS);
    expect(Math.abs(back.x - rect.x)).toBeLessThan(1);
    expect(Math.abs(back.y - rect.y)).toBeLessThan(1);
  });
});
