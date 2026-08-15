import { describe, expect, it } from 'vitest';

import { dropIndexFromRects, type ItemRect } from './dropTarget';

/** Four stacked 100px-tall rows, as the sidebar lays them out. */
const column: ItemRect[] = [0, 1, 2, 3].map((i) => ({
  left: 0,
  right: 100,
  top: i * 100,
  bottom: i * 100 + 100,
}));

/** Two rows of two 100x100 cells, as the organizer lays them out. */
const grid: ItemRect[] = [
  { left: 0, right: 100, top: 0, bottom: 100 },
  { left: 100, right: 200, top: 0, bottom: 100 },
  { left: 0, right: 100, top: 100, bottom: 200 },
  { left: 100, right: 200, top: 100, bottom: 200 },
];

describe('dropIndexFromRects in a column', () => {
  it('drops above the first page when the pointer is over its top half', () => {
    expect(dropIndexFromRects(column, 50, 10, false)).toBe(0);
  });

  it('drops below a page when the pointer is over its bottom half', () => {
    expect(dropIndexFromRects(column, 50, 90, false)).toBe(1);
  });

  it('flips at a page middle, which counts as below it', () => {
    // Page 2 spans 100..200, so its middle is 150.
    expect(dropIndexFromRects(column, 50, 149, false)).toBe(1);
    expect(dropIndexFromRects(column, 50, 150, false)).toBe(2);
  });

  it('drops at the end when the pointer is past the last page', () => {
    expect(dropIndexFromRects(column, 50, 9999, false)).toBe(4);
  });

  it('drops at the start when the pointer is above the list', () => {
    expect(dropIndexFromRects(column, 50, -50, false)).toBe(0);
  });

  it('has nowhere to go in an empty list', () => {
    expect(dropIndexFromRects([], 0, 0, false)).toBe(0);
  });
});

describe('dropIndexFromRects in a grid', () => {
  it('drops before a cell when the pointer is left of its middle', () => {
    expect(dropIndexFromRects(grid, 10, 50, true)).toBe(0);
    expect(dropIndexFromRects(grid, 110, 50, true)).toBe(1);
  });

  it('drops after a cell when the pointer is right of its middle', () => {
    expect(dropIndexFromRects(grid, 90, 50, true)).toBe(1);
  });

  it('drops at the end of a row when the pointer is past its last cell', () => {
    expect(dropIndexFromRects(grid, 190, 50, true)).toBe(2);
  });

  it('reads rows in order rather than jumping to the end', () => {
    // Second row, left cell: the gap is before page 3, not after page 4.
    expect(dropIndexFromRects(grid, 10, 150, true)).toBe(2);
  });

  it('drops at the start when the pointer is above the grid', () => {
    expect(dropIndexFromRects(grid, 150, -20, true)).toBe(0);
  });

  it('drops at the end when the pointer is below the grid', () => {
    expect(dropIndexFromRects(grid, 150, 500, true)).toBe(4);
  });

  it('drops between rows when the pointer is in the gutter', () => {
    const spaced: ItemRect[] = [
      { left: 0, right: 100, top: 0, bottom: 100 },
      { left: 0, right: 100, top: 120, bottom: 220 },
    ];
    expect(dropIndexFromRects(spaced, 50, 110, true)).toBe(1);
  });

  it('reads a short cell as still part of a row taller cells keep open', () => {
    // align-items: flex-start lets a row's cells differ in height -- a
    // landscape thumbnail is shorter than the portrait ones beside it. The
    // pointer sits under the short middle cell but below its own bottom,
    // still inside the row because its taller neighbours are not done yet.
    const unevenRow: ItemRect[] = [
      { left: 0, right: 100, top: 0, bottom: 300 },
      { left: 100, right: 200, top: 0, bottom: 220 },
      { left: 200, right: 300, top: 0, bottom: 300 },
      { left: 0, right: 100, top: 316, bottom: 616 },
    ];
    expect(dropIndexFromRects(unevenRow, 120, 260, true)).toBe(1);
  });
});
