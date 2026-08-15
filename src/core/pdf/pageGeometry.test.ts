// @vitest-environment node
import { degrees, PDFDocument, type PDFPage } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  boxRect,
  normalizeAngle,
  offsetInFrame,
  placeRect,
  rotateNormalizedPoint,
  rotateNormalizedRect,
  scaleHeight,
  scaleWidth,
  type NormalizedRect,
} from './pageGeometry';

const MEDIA_WIDTH = 400;
const MEDIA_HEIGHT = 600;

/** One page per rotation, all the same MediaBox, so only the turn varies. */
const pages: Record<number, PDFPage> = {};

beforeAll(async () => {
  const doc = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) {
    const page = doc.addPage([MEDIA_WIDTH, MEDIA_HEIGHT]);
    page.setRotation(degrees(angle));
    pages[angle] = page;
  }
});

/**
 * A rect covering the middle-left of the displayed page, whichever way up it
 * is: a quarter in from the left, half way down, half the width, a quarter of
 * the height.
 */
const RECT: NormalizedRect = { x: 0.25, y: 0.5, width: 0.5, height: 0.25 };

describe('placeRect', () => {
  it('maps an unrotated page straight through, flipping only the y origin', () => {
    // Screen: x 100..300 of 400, y 300..450 of 600 measured from the top.
    expect(placeRect(pages[0], RECT)).toEqual({
      x: 100,
      y: 150,
      width: 200,
      height: 150,
      rotate: degrees(0),
    });
  });

  it('anchors and turns a quarter-turned page', () => {
    // The displayed box is 600x400, so the same fractions cover screen
    // x 150..450, y 200..300. A 90 degree page sends screen-x along user-y.
    expect(placeRect(pages[90], RECT)).toEqual({
      x: 300,
      y: 150,
      width: 300,
      height: 100,
      rotate: degrees(90),
    });
  });

  it('anchors and turns an upside-down page', () => {
    expect(placeRect(pages[180], RECT)).toEqual({
      x: 300,
      y: 450,
      width: 200,
      height: 150,
      rotate: degrees(180),
    });
  });

  it('anchors and turns a three-quarter-turned page', () => {
    expect(placeRect(pages[270], RECT)).toEqual({
      x: 100,
      y: 450,
      width: 300,
      height: 100,
      rotate: degrees(270),
    });
  });

  it('keeps every placement inside the MediaBox', () => {
    for (const angle of [0, 90, 180, 270]) {
      const { x, y } = placeRect(pages[angle], RECT);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(MEDIA_WIDTH);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(MEDIA_HEIGHT);
    }
  });
});

describe('boxRect', () => {
  it('covers the same user-space area the placement draws into', () => {
    // Screen y 300..450 of 600, measured from the top, is user y 150..300.
    expect(boxRect(pages[0], RECT)).toEqual({ x0: 100, y0: 150, x1: 300, y1: 300 });
  });

  it('swaps the axes on a quarter turn', () => {
    expect(boxRect(pages[90], RECT)).toEqual({ x0: 200, y0: 150, x1: 300, y1: 450 });
  });

  it('stays axis-aligned and ordered on every turn', () => {
    for (const angle of [0, 90, 180, 270]) {
      const box = boxRect(pages[angle], RECT);
      expect(box.x1).toBeGreaterThan(box.x0);
      expect(box.y1).toBeGreaterThan(box.y0);
    }
  });

  it('agrees with placeRect on the area covered', () => {
    for (const angle of [0, 90, 180, 270]) {
      const box = boxRect(pages[angle], RECT);
      const placed = placeRect(pages[angle], RECT);
      // A quarter turn swaps which of the drawn box's sides runs along user x.
      const quarter = angle === 90 || angle === 270;
      expect(box.x1 - box.x0).toBeCloseTo(quarter ? placed.height : placed.width);
      expect(box.y1 - box.y0).toBeCloseTo(quarter ? placed.width : placed.height);
    }
  });
});

describe('offsetInFrame', () => {
  it('moves along the page axes when nothing is turned', () => {
    const placed = placeRect(pages[0], RECT);
    expect(offsetInFrame(placed, 10, 20)).toEqual({ x: placed.x + 10, y: placed.y + 20 });
  });

  it('sends the box own right along user y on a quarter turn', () => {
    const placed = placeRect(pages[90], RECT);
    expect(offsetInFrame(placed, 10, 20)).toEqual({ x: placed.x - 20, y: placed.y + 10 });
  });

  it('reverses both axes on a half turn', () => {
    const placed = placeRect(pages[180], RECT);
    expect(offsetInFrame(placed, 10, 20)).toEqual({ x: placed.x - 10, y: placed.y - 20 });
  });

  it('sends the box own right along negative user y on a three-quarter turn', () => {
    const placed = placeRect(pages[270], RECT);
    expect(offsetInFrame(placed, 10, 20)).toEqual({ x: placed.x + 20, y: placed.y - 10 });
  });

  it('lands on the opposite corner when offset by the full box', () => {
    // Stepping the box's own width and height from the anchor must reach the
    // corner diagonally opposite, whichever way the page is turned.
    for (const angle of [0, 90, 180, 270]) {
      const placed = placeRect(pages[angle], RECT);
      const far = offsetInFrame(placed, placed.width, placed.height);
      const box = boxRect(pages[angle], RECT);
      expect(Math.min(placed.x, far.x)).toBeCloseTo(box.x0);
      expect(Math.max(placed.x, far.x)).toBeCloseTo(box.x1);
      expect(Math.min(placed.y, far.y)).toBeCloseTo(box.y0);
      expect(Math.max(placed.y, far.y)).toBeCloseTo(box.y1);
    }
  });
});

describe('scaleWidth / scaleHeight', () => {
  it('measures against the displayed page, not the MediaBox', () => {
    expect(scaleWidth(pages[0], 0.5)).toBe(200);
    expect(scaleHeight(pages[0], 0.5)).toBe(300);
    // Quarter-turned, the displayed page is 600 wide and 400 tall.
    expect(scaleWidth(pages[90], 0.5)).toBe(300);
    expect(scaleHeight(pages[90], 0.5)).toBe(200);
  });
});

describe('rotateNormalizedRect', () => {
  const rect: NormalizedRect = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };

  it('carries a rect a quarter turn clockwise', () => {
    expect(rotateNormalizedRect(rect, 90)).toEqual({ x: 0.4, y: 0.1, width: 0.4, height: 0.3 });
  });

  it('carries a rect a quarter turn anticlockwise', () => {
    expect(rotateNormalizedRect(rect, -90)).toEqual({
      x: 0.2,
      y: 1 - 0.1 - 0.3,
      width: 0.4,
      height: 0.3,
    });
  });

  it('keeps the sides on a half turn', () => {
    expect(rotateNormalizedRect(rect, 180)).toEqual({
      x: 1 - 0.1 - 0.3,
      y: 1 - 0.2 - 0.4,
      width: 0.3,
      height: 0.4,
    });
  });

  it('leaves a rect alone on a full turn', () => {
    expect(rotateNormalizedRect(rect, 360)).toEqual(rect);
    expect(rotateNormalizedRect(rect, 0)).toEqual(rect);
  });

  it('returns to the start after four quarter turns', () => {
    let turned = rect;
    for (let i = 0; i < 4; i += 1) turned = rotateNormalizedRect(turned, 90);
    expect(turned.x).toBeCloseTo(rect.x);
    expect(turned.y).toBeCloseTo(rect.y);
    expect(turned.width).toBeCloseTo(rect.width);
    expect(turned.height).toBeCloseTo(rect.height);
  });

  it('undoes a clockwise turn with an anticlockwise one', () => {
    const there = rotateNormalizedRect(rect, 90);
    const back = rotateNormalizedRect(there, -90);
    expect(back.x).toBeCloseTo(rect.x);
    expect(back.y).toBeCloseTo(rect.y);
  });
});

describe('rotateNormalizedPoint', () => {
  it('carries a point round the turns', () => {
    expect(rotateNormalizedPoint({ x: 0.25, y: 0.5 }, 90)).toEqual({ x: 0.5, y: 0.25 });
    expect(rotateNormalizedPoint({ x: 0.25, y: 0.5 }, 180)).toEqual({ x: 0.75, y: 0.5 });
    expect(rotateNormalizedPoint({ x: 0.25, y: 0.5 }, 270)).toEqual({ x: 0.5, y: 0.75 });
  });

  it('returns to the start after four quarter turns', () => {
    let point = { x: 0.3, y: 0.8 };
    for (let i = 0; i < 4; i += 1) point = rotateNormalizedPoint(point, 90);
    expect(point.x).toBeCloseTo(0.3);
    expect(point.y).toBeCloseTo(0.8);
  });
});

describe('normalizeAngle', () => {
  it('folds any turn into 0, 90, 180 or 270', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(-450)).toBe(270);
    expect(normalizeAngle(0)).toBe(0);
  });
});
