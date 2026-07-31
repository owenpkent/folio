import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';

// Every ring change drives the engine (rasterise, or measure the page). None of
// these tests care about pixels, so the engine is a set of resolving no-ops.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return {
    ...actual,
    getEngine: () => ({
      renderPage: async () => {},
      renderTextLayer: async () => {},
      renderAnnotationLayer: async () => {},
      getPageDimensions: async () => ({ width: 612, height: 792 }),
      // ImageEditLayer asks for one as soon as it mounts.
      getPageViewport: async () => ({
        width: 612,
        height: 792,
        convertToPdfPoint: (x: number, y: number) => [x, y],
        convertToViewportRectangle: (rect: number[]) => rect,
      }),
    }),
  };
});

import { resetPageSizes } from '@/core/pdf/pageSizes';
import { useEditStore } from '@/features/editing';

import { Page } from './Page';

/**
 * The same recording IntersectionObserver hooks/useNearViewport.test.tsx uses:
 * jsdom has none, and these tests are about what the page does as its rings
 * report it in and out of range, which only a driveable observer can say.
 */
class FakeObserver {
  static instances: FakeObserver[] = [];

  targets = new Set<Element>();

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit | undefined,
  ) {
    FakeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
  }

  fire(entries: { target: Element; isIntersecting: boolean }[]): void {
    act(() => {
      this.callback(entries as unknown as IntersectionObserverEntry[], this as never);
    });
  }
}

const PAGE = 3;
const RECT = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };

// The page is rendered inside the real scroller element so the rootSelector the
// rings pass has something to resolve to, exactly as it does in the app.
function renderPage() {
  return render(
    <div className="folio-viewer">
      <Page pageNumber={PAGE} scale={1} />
    </div>,
  );
}

function ring(rootMargin: string): FakeObserver {
  const observer = FakeObserver.instances.find((o) => o.options?.rootMargin === rootMargin);
  if (!observer) throw new Error(`no observer for rootMargin ${rootMargin}`);
  return observer;
}

/** The text the store holds for a box, i.e. everything that has been committed. */
function storedText(id: string): string | null {
  const item = useEditStore.getState().edits.find((e) => e.id === id);
  return item?.kind === 'text' ? item.text : null;
}

/** Report the page in (or out of) both rings at once, the way a scroll does. */
function reportNear(isIntersecting: boolean): void {
  const target = document.querySelector('.folio-page');
  if (!target) throw new Error('page element not rendered');
  for (const margin of ['600px 0px', '2400px 0px']) {
    ring(margin).fire([{ target, isIntersecting }]);
  }
}

describe('Page', () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useEditStore.getState().reset();
    resetPageSizes();
  });

  it('roots both rings at the scroller, not the viewport', () => {
    renderPage();

    // Rooted at the viewport, the scroller's own overflow clips both rings away
    // and the wide one stops being wider than the narrow one.
    expect(FakeObserver.instances).toHaveLength(2);
    for (const observer of FakeObserver.instances) {
      expect(observer.options?.root).toHaveClass('folio-viewer');
    }
    expect(FakeObserver.instances.map((o) => o.options?.rootMargin).sort()).toEqual([
      '2400px 0px',
      '600px 0px',
    ]);
  });

  it('keeps a text box that is being edited mounted when the page leaves the ring', () => {
    const item = useEditStore.getState().addText(PAGE, RECT);
    renderPage();
    act(() => reportNear(true));

    // Freshly-created boxes take focus themselves, so this is the state a user
    // is in while typing: text in the element, nothing committed to the store.
    const box = screen.getByRole('textbox', { name: 'Text box' });
    expect(document.activeElement).toBe(box);
    box.textContent = 'not committed yet';

    // Wheel and keyboard scrolling do not blur, so nothing has committed by the
    // time the page falls out of the ring.
    act(() => reportNear(false));
    expect(screen.getByRole('textbox', { name: 'Text box' })).toHaveTextContent(
      'not committed yet',
    );
    expect(storedText(item.id)).toBe('');

    // Scrolling back must not rewrite the element from the stale stored value.
    act(() => reportNear(true));
    expect(screen.getByRole('textbox', { name: 'Text box' })).toHaveTextContent(
      'not committed yet',
    );

    // Blur still commits: the pin changes when the layer unmounts, nothing else.
    act(() => {
      box.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(storedText(item.id)).toBe('not committed yet');
  });

  it('unmounts the overlays of a page holding nothing live', () => {
    useEditStore.getState().addText(PAGE, RECT);
    useEditStore.getState().clearFocus();
    useEditStore.getState().select(null);

    renderPage();
    act(() => reportNear(true));
    expect(screen.getByRole('textbox', { name: 'Text box' })).toBeInTheDocument();

    act(() => reportNear(false));
    expect(screen.queryByRole('textbox', { name: 'Text box' })).not.toBeInTheDocument();
  });
});
