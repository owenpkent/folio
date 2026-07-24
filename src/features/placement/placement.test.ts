import { describe, expect, it } from 'vitest';

import { rectAt } from './rect';

describe('rectAt', () => {
  it('anchors a text box at the click point', () => {
    expect(rectAt({ x: 0.2, y: 0.3 }, 0.34, 0.05, 'topLeft')).toEqual({
      x: 0.2,
      y: 0.3,
      width: 0.34,
      height: 0.05,
    });
  });

  it('centers an image on the click point', () => {
    expect(rectAt({ x: 0.5, y: 0.5 }, 0.28, 0.1, 'center')).toEqual({
      x: 0.36,
      y: 0.45,
      width: 0.28,
      height: 0.1,
    });
  });

  it('keeps a rect dropped near an edge fully on the page', () => {
    const bottomRight = rectAt({ x: 0.98, y: 0.99 }, 0.34, 0.05, 'topLeft');
    expect(bottomRight.x).toBeCloseTo(0.66);
    expect(bottomRight.y).toBeCloseTo(0.95);

    const topLeft = rectAt({ x: 0.01, y: 0.0 }, 0.28, 0.1, 'center');
    expect(topLeft.x).toBe(0);
    expect(topLeft.y).toBe(0);
  });

  it('clamps a rect larger than the page instead of pushing it off', () => {
    expect(rectAt({ x: 0.5, y: 0.5 }, 1.4, 2, 'center')).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});
