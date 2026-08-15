import { Fragment, useCallback, useRef } from 'react';

import { useViewerStore } from '@/state/viewerStore';

import { deleteSelectedPages } from './operations';
import { PageThumb } from './PageThumb';
import { usePageOpsStore } from './store';
import { usePageDrag } from './usePageDrag';

interface PageListProps {
  /** A single column (the sidebar) or a wrapping grid (the organizer). */
  layout: 'column' | 'grid';
  /** Selector for the scrolling ancestor, for lazy rasterisation and drag maths. */
  scrollRoot: string;
  scale: number;
  rootMargin: string;
  /** Extra behaviour when a page is opened, e.g. dismissing a drawer. */
  onNavigate?: (pageNumber: number) => void;
}

/**
 * The list of pages, with selection, keyboard operation, and drag to reorder.
 *
 * Both page surfaces render this, so the sidebar and the organizer cannot drift
 * apart in how selection or dragging behaves.
 */
export function PageList({ layout, scrollRoot, scale, rootMargin, onNavigate }: PageListProps) {
  const numPages = useViewerStore((s) => s.numPages);
  const currentPage = useViewerStore((s) => s.currentPage);
  const containerRef = useRef<HTMLDivElement>(null);
  const grid = layout === 'grid';

  const { draggingPage, dropIndex, startDrag } = usePageDrag({
    containerRef,
    itemSelector: '.folio-page-card',
    grid,
  });

  const handleSelect = useCallback((pageNumber: number, range: boolean) => {
    const ops = usePageOpsStore.getState();
    if (range) ops.extendTo(pageNumber);
    else ops.toggle(pageNumber);
  }, []);

  const handleActivate = useCallback(
    (pageNumber: number, event: React.MouseEvent) => {
      // Ctrl/Cmd-click is the pointer shorthand for "add this to the selection"
      // rather than "take me there", matching every other list of things.
      if (event.metaKey || event.ctrlKey) {
        usePageOpsStore.getState().toggle(pageNumber);
        return;
      }
      if (event.shiftKey) {
        usePageOpsStore.getState().extendTo(pageNumber);
        return;
      }
      useViewerStore.getState().goToPage(pageNumber);
      onNavigate?.(pageNumber);
    },
    [onNavigate],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, pageNumber: number) => {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        // Delete and Backspace are gated to the organizer grid: this button's
        // accessible name is "Go to page N", and in the reading sidebar that
        // reads exactly like any other "go back" control browser-back muscle
        // memory reaches for. The organizer is where the user came
        // specifically to reorganise pages, so a destructive key there is
        // expected rather than a trap.
        if (!grid) return;
        event.preventDefault();
        const ops = usePageOpsStore.getState();
        // Pressing Delete on a page nobody has picked out means that page.
        if (ops.selection.size === 0) ops.select(pageNumber);
        void deleteSelectedPages();
        return;
      }
      if (event.key === ' ') {
        // Space picks the page out instead of opening it, the way it does in a
        // file list. Enter still goes to the page.
        event.preventDefault();
        usePageOpsStore.getState().toggle(pageNumber);
      }
    },
    [grid],
  );

  if (!numPages) {
    return <p className="folio-sidebar__empty">No document open.</p>;
  }

  return (
    <div className={grid ? 'folio-page-grid' : 'folio-thumbnails'} ref={containerRef}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
        <Fragment key={pageNumber}>
          {dropIndex === pageNumber - 1 && <DropMarker />}
          <PageThumb
            pageNumber={pageNumber}
            active={pageNumber === currentPage}
            anyDragging={draggingPage !== null}
            scale={scale}
            scrollRoot={scrollRoot}
            rootMargin={rootMargin}
            onSelect={handleSelect}
            onActivate={handleActivate}
            onPointerDown={startDrag}
            onKeyDown={handleKeyDown}
          />
        </Fragment>
      ))}
      {dropIndex === numPages && <DropMarker />}
    </div>
  );
}

function DropMarker() {
  return <div className="folio-page-drop" aria-hidden="true" />;
}
