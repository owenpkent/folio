/**
 * Working out which gap in a page list a drag is hovering over.
 *
 * Split out from the drag hook because it is the part with the edge cases (the
 * pointer above the first page, below the last, or between two rows of a grid)
 * and the only part worth testing without a DOM.
 */

/** Just enough of a DOMRect to place a pointer against it. */
export interface ItemRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The gap the pointer is over, counted as "pages above it": 0 is above the
 * first page and `rects.length` is below the last.
 *
 * A single column compares against each page's middle. A grid reads in rows
 * first, then position within the row, so dragging across a row inserts before
 * the page you are left of rather than jumping to the end.
 */
export function dropIndexFromRects(
  rects: readonly ItemRect[],
  x: number,
  y: number,
  grid: boolean,
): number {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (!grid) {
      if (y < rect.top + (rect.bottom - rect.top) / 2) return index;
      continue;
    }
    // Above this page's row entirely: every page from here on is below the
    // pointer, so the gap is right here.
    if (y < rect.top) return index;
    if (y <= rect.bottom && x < rect.left + (rect.right - rect.left) / 2) return index;
  }
  return rects.length;
}
