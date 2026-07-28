// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { backingStoreScale } from './PdfJsEngine';

// A Letter page at 100% zoom, comfortably inside the canvas budget.
const LETTER = [612, 792] as const;

describe('backingStoreScale', () => {
  it('supersamples a 1x display so there is something to downsample from', () => {
    // The whole reason for rendering above CSS resolution: it is what keeps text
    // crisp where the platform under-reports DPI, and on genuinely 1x panels.
    expect(backingStoreScale(...LETTER, 1)).toBe(2);
  });

  it('never renders below the display density, including above the old 3x ceiling', () => {
    // Issue #29: the target used to be `min(3, max(2, dpr))`, so a panel
    // reporting more than 3 was handed a 3x store it then had to stretch.
    expect(backingStoreScale(...LETTER, 2)).toBe(2);
    expect(backingStoreScale(...LETTER, 3)).toBe(3);
    expect(backingStoreScale(...LETTER, 3.5)).toBe(3.5);
    expect(backingStoreScale(...LETTER, 4)).toBe(4);
  });

  it('honours a fractional ratio rather than rounding it away', () => {
    // Windows at 125% / 133% / 150%, the case the supersampling exists for.
    // Below SUPERSAMPLE_MIN these all clamp up to 2, which is >= the display.
    for (const dpr of [1.25, 4 / 3, 1.5]) {
      expect(backingStoreScale(...LETTER, dpr)).toBeGreaterThanOrEqual(dpr);
    }
  });

  it('lets the pixel budget win on a page too large to honour the display', () => {
    // ~5000x5000 CSS px: sqrt(2^24 / 25e6) ≈ 0.819, so the budget forces a
    // sub-1x store even on a 2x panel. Accepted deliberately — a floor here
    // would hand the browser an oversized canvas it downscales anyway.
    const scale = backingStoreScale(5000, 5000, 2);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeCloseTo(Math.sqrt(16_777_216 / 25_000_000), 6);
  });

  it('caps by max dimension, not only by area, for a long thin page', () => {
    // 8000x400 is only 3.2M px (inside the area budget) but far past the
    // 4096-per-side limit, which is the bound that has to bite here.
    expect(backingStoreScale(8000, 400, 2)).toBeCloseTo(4096 / 8000, 6);
  });

  it('never returns a scale that busts either bound', () => {
    for (const [w, h] of [
      [612, 792],
      [1224, 1584],
      [3000, 3000],
      [5000, 5000],
      [8000, 400],
    ] as const) {
      for (const dpr of [1, 1.5, 2, 3, 4]) {
        const s = backingStoreScale(w, h, dpr);
        expect(Math.max(w * s, h * s)).toBeLessThanOrEqual(4096 + 1e-9);
        expect(w * s * h * s).toBeLessThanOrEqual(16_777_216 + 1e-6);
      }
    }
  });
});
