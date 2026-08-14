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
  if (!grid) {
    for (let index = 0; index < rects.length; index += 1) {
      if (y < rects[index].top + (rects[index].bottom - rects[index].top) / 2) return index;
    }
    return rects.length;
  }

  let start = 0;
  while (start < rects.length) {
    // `.folio-page-grid` uses `align-items: flex-start`, so a row's cells
    // share one top but not necessarily one bottom: a landscape thumbnail is
    // shorter than the portrait ones next to it. Reading a short cell's own
    // bottom as its row's bottom would end the row early and skip the pointer
    // past whatever comes after it in the same row, so the row's bottom is
    // its tallest cell, found by grouping on shared top instead.
    let end = start + 1;
    let rowBottom = rects[start].bottom;
    while (end < rects.length && rects[end].top === rects[start].top) {
      rowBottom = Math.max(rowBottom, rects[end].bottom);
      end += 1;
    }

    // Above this row entirely: every page from here on is below the pointer,
    // so the gap is right here.
    if (y < rects[start].top) return start;
    if (y <= rowBottom) {
      for (let index = start; index < end; index += 1) {
        if (x < rects[index].left + (rects[index].right - rects[index].left) / 2) return index;
      }
      return end;
    }

    start = end;
  }

  return rects.length;
}
