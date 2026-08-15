import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';

// The viewer only asks the engine for page 1's natural size (to compute the fit
// scale); everything these tests care about is layout and scroll position.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return {
    ...actual,
    getEngine: () => ({
      getPageDimensions: async () => ({ width: 612, height: 792 }),
    }),
  };
});

// Stands in for the real page: these tests drive its offsetTop by hand, which
// is the only thing the re-aim below reads off it.
vi.mock('./Page', () => ({
  Page: ({ pageNumber }: { pageNumber: number }) => (
    <div className="folio-page" data-page-number={pageNumber} />
  ),
}));

import { primePageSizeEstimate, resetPageSizes } from '@/core/pdf/pageSizes';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { PdfViewer } from './PdfViewer';

const TARGET_PAGE = 3;

/** jsdom lays nothing out, so offsetTop is stubbed and moved by hand. */
function stubOffsetTop(el: HTMLElement, read: () => number): void {
  Object.defineProperty(el, 'offsetTop', { configurable: true, get: read });
}

describe('PdfViewer scroll-to-page', () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  let targetTop = 0;

  beforeEach(() => {
    targetTop = 0;
    scrollTo = vi.fn();
    // jsdom has neither, and the viewer wires both up on mount.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    // Immediate frames keep the re-aim (which defers its offsetTop read by one)
    // synchronous with the measurement that triggered it.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    useDocumentStore.setState({ status: 'ready' });
    useViewerStore.setState({ numPages: 5 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useDocumentStore.getState().reset();
    useViewerStore.getState().reset();
    resetPageSizes();
  });

  function mount() {
    const view = render(<PdfViewer />);
    const container = document.querySelector<HTMLElement>('.folio-viewer');
    if (!container) throw new Error('viewer did not render');
    container.scrollTo = scrollTo as unknown as typeof container.scrollTo;
    const page = container.querySelector<HTMLElement>(
      `.folio-page[data-page-number="${TARGET_PAGE}"]`,
    );
    if (!page) throw new Error('target page did not render');
    stubOffsetTop(page, () => targetTop);
    return view;
  }

  it('re-aims at the target when a measurement lands after the request was taken', () => {
    mount();

    act(() => useViewerStore.getState().goToPage(TARGET_PAGE));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    // The request is consumed immediately; the re-aim must outlive that.
    expect(useViewerStore.getState().pendingScrollPage).toBeNull();

    // A page above the target measured taller than its estimate, so the target
    // has moved down: this is the correction the jump depends on.
    targetTop = 5000;
    act(() => primePageSizeEstimate({ width: 612, height: 900 }));

    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 4984, behavior: 'smooth' });
  });

  it('holds a request issued before the pages are committed', () => {
    // Opening a document straight to a page (the post-update resume) marks the
    // store ready and asks for the page in the same turn, a microtask before
    // React commits a single page element. The subscription that hears it
    // there has nothing to scroll to; consuming the request at that point
    // dropped the jump for good, and every resume landed on page 1.
    useDocumentStore.setState({ status: 'loading' });
    useViewerStore.setState({ numPages: 0 });

    render(<PdfViewer />);
    const container = document.querySelector<HTMLElement>('.folio-viewer');
    if (!container) throw new Error('viewer did not render');
    container.scrollTo = scrollTo as unknown as typeof container.scrollTo;

    act(() => {
      useViewerStore.setState({ numPages: 5 });
      useDocumentStore.setState({ status: 'ready' });
      useViewerStore.getState().goToPage(TARGET_PAGE);
    });

    expect(scrollTo).toHaveBeenCalledTimes(1);
    // And consumed once it has actually been served, so the next request for
    // the same page is still a change the subscription can see.
    expect(useViewerStore.getState().pendingScrollPage).toBeNull();
  });

  it('re-aims only while the target is still moving', () => {
    mount();

    act(() => useViewerStore.getState().goToPage(TARGET_PAGE));
    targetTop = 5000;
    act(() => primePageSizeEstimate({ width: 612, height: 900 }));
    // Same target as the last aim: nothing to correct, so nothing is issued.
    act(() => primePageSizeEstimate({ width: 612, height: 900 }));

    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it('drops the re-aim subscription when the viewer goes away', () => {
    const view = mount();

    act(() => useViewerStore.getState().goToPage(TARGET_PAGE));
    view.unmount();

    targetTop = 5000;
    act(() => primePageSizeEstimate({ width: 612, height: 900 }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('stops re-aiming once the window closes', () => {
    vi.useFakeTimers();
    try {
      mount();

      act(() => useViewerStore.getState().goToPage(TARGET_PAGE));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });

      targetTop = 5000;
      act(() => primePageSizeEstimate({ width: 612, height: 900 }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
