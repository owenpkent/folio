import { describe, expect, it } from 'vitest';

import { deletePlan, movePlan, nudgePlan, QUARTER_TURN, rotatePlan } from './plans';

const pages = (...numbers: number[]) => new Set(numbers);

describe('deletePlan', () => {
  it('leaves out the selected pages', () => {
    expect(deletePlan(5, pages(2, 4))?.order).toEqual([0, 2, 4]);
  });

  it('refuses to empty the document', () => {
    expect(deletePlan(2, pages(1, 2))).toBeNull();
  });
});

describe('movePlan', () => {
  it('moves one page up', () => {
    // Page 4 dropped into the gap above page 2.
    expect(movePlan(5, pages(4), 1).order).toEqual([0, 3, 1, 2, 4]);
  });

  it('moves one page down', () => {
    expect(movePlan(5, pages(1), 3).order).toEqual([1, 2, 0, 3, 4]);
  });

  it('is a no-op when a page is dropped back where it started', () => {
    expect(movePlan(5, pages(3), 2).order).toEqual([0, 1, 2, 3, 4]);
  });

  it('drops a page at the very top', () => {
    expect(movePlan(4, pages(3), 0).order).toEqual([2, 0, 1, 3]);
  });

  it('drops a page at the very bottom', () => {
    expect(movePlan(4, pages(1), 4).order).toEqual([1, 2, 3, 0]);
  });

  it('keeps a multi-page selection in its own order', () => {
    expect(movePlan(5, pages(2, 4), 0).order).toEqual([1, 3, 0, 2, 4]);
  });

  it('gathers a selection with gaps in it', () => {
    // 1 and 3 lift out, then land together below what is now the last page.
    expect(movePlan(4, pages(1, 3), 4).order).toEqual([1, 3, 0, 2]);
  });
});

describe('nudgePlan', () => {
  it('swaps a page with the one above it', () => {
    expect(nudgePlan(5, pages(3), -1)?.order).toEqual([0, 2, 1, 3, 4]);
  });

  it('swaps a page with the one below it', () => {
    expect(nudgePlan(5, pages(3), 1)?.order).toEqual([0, 1, 3, 2, 4]);
  });

  it('moves a contiguous block as one', () => {
    expect(nudgePlan(5, pages(2, 3), -1)?.order).toEqual([1, 2, 0, 3, 4]);
    expect(nudgePlan(5, pages(2, 3), 1)?.order).toEqual([0, 3, 1, 2, 4]);
  });

  it('stops at the top', () => {
    expect(nudgePlan(5, pages(1), -1)).toBeNull();
    expect(nudgePlan(5, pages(1, 2), -1)).toBeNull();
  });

  it('stops at the bottom', () => {
    expect(nudgePlan(5, pages(5), 1)).toBeNull();
    expect(nudgePlan(5, pages(4, 5), 1)).toBeNull();
  });

  it('does nothing without a selection', () => {
    expect(nudgePlan(5, pages(), -1)).toBeNull();
  });

  it('round-trips: down then up returns to the start', () => {
    const down = nudgePlan(5, pages(2), 1);
    expect(down?.order).toEqual([0, 2, 1, 3, 4]);
    // Page 2 now sits third, so nudging it back up restores the original order.
    const up = nudgePlan(5, pages(3), -1);
    expect(up?.order).toEqual([0, 2, 1, 3, 4]);
  });
});

describe('rotatePlan', () => {
  it('turns the selected pages and keeps the order', () => {
    const plan = rotatePlan(3, pages(1, 3), QUARTER_TURN);
    expect(plan?.order).toEqual([0, 1, 2]);
    expect(plan?.rotateBy).toEqual({ 0: 90, 2: 90 });
  });

  it('turns anticlockwise', () => {
    expect(rotatePlan(2, pages(2), -QUARTER_TURN)?.rotateBy).toEqual({ 1: -90 });
  });

  it('does nothing without a selection', () => {
    expect(rotatePlan(3, pages(), QUARTER_TURN)).toBeNull();
  });
});
