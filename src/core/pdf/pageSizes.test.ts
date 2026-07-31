import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getIntrinsicSize,
  measurePage,
  primePageSizeEstimate,
  resetPageSizes,
  subscribePageSizes,
} from './pageSizes';

const getPageDimensions = vi.fn();

vi.mock('./index', () => ({
  getEngine: () => ({ getPageDimensions }),
}));

/** Let the mocked engine promise and its `.then` settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('pageSizes', () => {
  beforeEach(() => {
    resetPageSizes();
    getPageDimensions.mockReset();
    getPageDimensions.mockResolvedValue({ width: 612, height: 792 });
  });

  afterEach(() => {
    resetPageSizes();
  });

  it('knows nothing before anything is primed or measured', () => {
    expect(getIntrinsicSize(1)).toBeNull();
  });

  it('reports the primed estimate for every unmeasured page', () => {
    primePageSizeEstimate({ width: 612, height: 792 });

    expect(getIntrinsicSize(1)).toEqual({ width: 612, height: 792 });
    expect(getIntrinsicSize(4000)).toEqual({ width: 612, height: 792 });
  });

  it('measures a page at scale 1, so one measurement serves every zoom level', async () => {
    measurePage(7);
    await settle();

    expect(getPageDimensions).toHaveBeenCalledWith(7, 1);
  });

  it("prefers a page's own measurement over the estimate", async () => {
    primePageSizeEstimate({ width: 612, height: 792 });
    getPageDimensions.mockResolvedValue({ width: 1224, height: 1584 });

    measurePage(3);
    await settle();

    expect(getIntrinsicSize(3)).toEqual({ width: 1224, height: 1584 });
    // Other pages keep the estimate.
    expect(getIntrinsicSize(4)).toEqual({ width: 612, height: 792 });
  });

  it('measures a given page at most once, however often it is asked', async () => {
    measurePage(2);
    measurePage(2);
    await settle();
    measurePage(2);
    await settle();

    expect(getPageDimensions).toHaveBeenCalledTimes(1);
  });

  it('re-measures after a failure rather than caching the miss', async () => {
    getPageDimensions.mockRejectedValueOnce(new Error('worker died'));

    measurePage(5);
    await settle();
    expect(getIntrinsicSize(5)).toBeNull();

    getPageDimensions.mockResolvedValue({ width: 100, height: 200 });
    measurePage(5);
    await settle();
    expect(getIntrinsicSize(5)).toEqual({ width: 100, height: 200 });
  });

  it('does not notify when a measurement confirms the estimate', async () => {
    primePageSizeEstimate({ width: 612, height: 792 });
    const listener = vi.fn();
    subscribePageSizes(listener);

    measurePage(9); // resolves to exactly the estimate
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies when a measurement corrects the estimate', async () => {
    primePageSizeEstimate({ width: 612, height: 792 });
    const listener = vi.fn();
    subscribePageSizes(listener);
    getPageDimensions.mockResolvedValue({ width: 612, height: 1000 });

    measurePage(9);
    await settle();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying once unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePageSizes(listener);
    unsubscribe();

    primePageSizeEstimate({ width: 1, height: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('reset clears sizes and estimate, and lets a page be measured again', async () => {
    primePageSizeEstimate({ width: 612, height: 792 });
    measurePage(1);
    await settle();

    resetPageSizes();
    expect(getIntrinsicSize(1)).toBeNull();

    measurePage(1);
    await settle();
    expect(getPageDimensions).toHaveBeenCalledTimes(2);
  });

  it('reset notifies subscribers so the viewer re-lays out', () => {
    const listener = vi.fn();
    subscribePageSizes(listener);

    resetPageSizes();
    expect(listener).toHaveBeenCalled();
  });
});
