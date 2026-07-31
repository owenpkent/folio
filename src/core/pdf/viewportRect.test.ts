import { describe, expect, it } from 'vitest';

import type { PageViewport } from 'pdfjs-dist';

import { convertToViewportRectangle } from './viewportRect';

/**
 * A viewport whose point conversion is PDF.js's own: scale, then flip y about
 * the page height. Enough to pin the two things the removed
 * `convertToViewportRectangle` guaranteed -- both corners converted, in corner
 * order rather than normalised.
 */
function viewport(scale: number, pageHeight: number): PageViewport {
  return {
    convertToViewportPoint: (x: number, y: number) => [x * scale, (pageHeight - y) * scale],
  } as unknown as PageViewport;
}

describe('convertToViewportRectangle', () => {
  it('converts both corners of the rect', () => {
    expect(convertToViewportRectangle(viewport(2, 100), [10, 20, 30, 40])).toEqual([
      20, 160, 60, 120,
    ]);
  });

  it('leaves the y axis inverted rather than normalising the rect', () => {
    // y0 > y1 on the way out: PDF space is bottom-left origin, viewport space is
    // top-left. Callers (ImageEditLayer, TextEditLayer) do their own min/abs.
    const [, y0, , y1] = convertToViewportRectangle(viewport(1, 100), [0, 10, 0, 40]);
    expect(y0).toBeGreaterThan(y1);
  });

  it('is the identity when the viewport is', () => {
    const identity = {
      convertToViewportPoint: (x: number, y: number) => [x, y],
    } as unknown as PageViewport;
    expect(convertToViewportRectangle(identity, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });
});
