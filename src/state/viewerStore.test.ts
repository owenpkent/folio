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

  it('clamps goToPage to the document bounds and requests a scroll', () => {
    useViewerStore.getState().setNumPages(10);

    useViewerStore.getState().goToPage(99);
    expect(useViewerStore.getState().currentPage).toBe(10);
    expect(useViewerStore.getState().pendingScrollPage).toBe(10);

    useViewerStore.getState().goToPage(-3);
    expect(useViewerStore.getState().currentPage).toBe(1);
  });

  it('switches to custom fit mode when zooming or setting a scale manually', () => {
    useViewerStore.getState().setFitMode('width');
    useViewerStore.getState().zoomIn();
    expect(useViewerStore.getState().fitMode).toBe('custom');

    useViewerStore.getState().setFitMode('page');
    useViewerStore.getState().setScale(2);
    expect(useViewerStore.getState().fitMode).toBe('custom');
    expect(useViewerStore.getState().scale).toBe(2);
  });

  it('setScale clamps out-of-range values', () => {
    useViewerStore.getState().setScale(999);
    expect(useViewerStore.getState().scale).toBe(MAX_SCALE);
    useViewerStore.getState().setScale(0.0001);
    expect(useViewerStore.getState().scale).toBe(MIN_SCALE);
  });

  it('toggles sidebar and opens it when a tab is selected', () => {
    useViewerStore.getState().setSidebarOpen(false);
    useViewerStore.getState().toggleSidebar();
    expect(useViewerStore.getState().sidebarOpen).toBe(true);

    useViewerStore.getState().setSidebarOpen(false);
    useViewerStore.getState().setSidebarTab('outline');
    expect(useViewerStore.getState().sidebarTab).toBe('outline');
    expect(useViewerStore.getState().sidebarOpen).toBe(true);
  });

  it('toggles search and clears the pending scroll', () => {
    useViewerStore.getState().toggleSearch();
    expect(useViewerStore.getState().searchOpen).toBe(true);
    useViewerStore.getState().goToPage(1);
    useViewerStore.getState().clearPendingScroll();
    expect(useViewerStore.getState().pendingScrollPage).toBeNull();
  });

  it('reset restores defaults', () => {
    useViewerStore.getState().setNumPages(9);
    useViewerStore.getState().setScale(3);
    useViewerStore.getState().setSignatureModalOpen(true);
    useViewerStore.getState().reset();
    const s = useViewerStore.getState();
    expect(s.scale).toBe(1.2);
    expect(s.fitMode).toBe('width');
    expect(s.numPages).toBe(0);
    expect(s.signatureModalOpen).toBe(false);
  });
});
