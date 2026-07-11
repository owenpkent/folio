import { beforeEach, describe, expect, it } from 'vitest';

import { MAX_SCALE, MIN_SCALE, useViewerStore } from './viewerStore';

describe('viewerStore', () => {
  beforeEach(() => useViewerStore.getState().reset());

  it('clamps zoom within bounds', () => {
    for (let i = 0; i < 50; i++) useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().scale).toBeLessThanOrEqual(MAX_SCALE);

    for (let i = 0; i < 80; i++) useViewerStore.getState().zoomOut();
    expect(useViewerStore.getState().scale).toBeGreaterThanOrEqual(MIN_SCALE);
  });

  it('clamps goToPage to the document bounds', () => {
    useViewerStore.getState().setNumPages(10);

    useViewerStore.getState().goToPage(99);
    expect(useViewerStore.getState().currentPage).toBe(10);

    useViewerStore.getState().goToPage(-3);
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('switches to custom fit mode when zooming manually', () => {
    useViewerStore.getState().setFitMode('width');
    useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().fitMode).toBe('custom');
  });
});
