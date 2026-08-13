import { useCallback, useEffect, useRef, useState } from 'react';

import { dropIndexFromRects, type ItemRect } from './dropTarget';
import { moveSelectionTo } from './operations';
import { usePageOpsStore } from './store';

/** How far the pointer has to travel before a press becomes a drag, in px. */
const DRAG_THRESHOLD = 5;

interface PageDragOptions {
  /** The element the page items live inside. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Selector matching each draggable page, in page order. */
  itemSelector: string;
  /** Grids read in rows; a single column only compares vertically. */
  grid: boolean;
}

export interface PageDrag {
  /** The page under the pointer's grip, or null when nothing is being dragged. */
  draggingPage: number | null;
  /** Pages above the gap the drag would drop into, or null when not dragging. */
  dropIndex: number | null;
  startDrag(event: React.PointerEvent, pageNumber: number): void;
}

/**
 * Pointer-driven drag to reorder pages.
 *
 * Hand-rolled on pointer events rather than HTML5 drag-and-drop, matching how
 * every other draggable thing in the app works (see EditLayer, SignatureLayer),
 * and gated behind a small movement threshold so a press still reads as a click
 * on what is, in the sidebar, a navigation button.
 *
 * Touch is deliberately excluded: in the sidebar a vertical drag is how you
 * scroll the panel, and stealing that would trade a common gesture for a rare
 * one. Touch users reorder with the selection bar's move buttons instead.
 */
export function usePageDrag({ containerRef, itemSelector, grid }: PageDragOptions): PageDrag {
  const [draggingPage, setDraggingPage] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // The live gesture, plus the measurements and the latest target. Refs because
  // the window listeners below outlive the render that installed them.
  const gesture = useRef<{ page: number; x: number; y: number; dragging: boolean } | null>(null);
  const rects = useRef<ItemRect[]>([]);
  const target = useRef<number | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    rects.current = [...container.querySelectorAll<HTMLElement>(itemSelector)].map((el) =>
      el.getBoundingClientRect(),
    );
  }, [containerRef, itemSelector]);

  // Measuring every page on every pointermove is a getBoundingClientRect per
  // page per frame, which a few hundred pages feel. The layout only moves when
  // something scrolls or resizes, so measure then instead.
  useEffect(() => {
    if (draggingPage === null) return;
    const remeasure = () => measure();
    window.addEventListener('scroll', remeasure, { capture: true, passive: true });
    window.addEventListener('resize', remeasure, { passive: true });
    return () => {
      window.removeEventListener('scroll', remeasure, { capture: true });
      window.removeEventListener('resize', remeasure);
    };
  }, [draggingPage, measure]);

  const startDrag = useCallback(
    (event: React.PointerEvent, page: number) => {
      if (event.button !== 0 || event.pointerType === 'touch') return;
      gesture.current = { page, x: event.clientX, y: event.clientY, dragging: false };

      const onMove = (e: PointerEvent) => {
        const g = gesture.current;
        if (!g) return;

        if (!g.dragging) {
          if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < DRAG_THRESHOLD) return;
          g.dragging = true;
          // Dragging a page that is not part of the selection acts on that page
          // alone; dragging one that is moves the whole selection with it.
          const ops = usePageOpsStore.getState();
          if (!ops.selection.has(g.page)) ops.select(g.page);
          measure();
          setDraggingPage(g.page);
        }

        target.current = dropIndexFromRects(rects.current, e.clientX, e.clientY, grid);
        setDropIndex(target.current);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);

        const g = gesture.current;
        const dropAt = target.current;
        gesture.current = null;
        target.current = null;
        setDraggingPage(null);
        setDropIndex(null);

        if (!g?.dragging) return;
        // The click that follows the release would otherwise navigate to
        // whatever page the drag happened to finish over.
        swallowNextClick();
        if (dropAt !== null) void moveSelectionTo(dropAt);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [grid, measure],
  );

  return { draggingPage, dropIndex, startDrag };
}

function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  // If the release produced no click at all (the pointer left the window, say),
  // the listener would sit there and eat an unrelated one later.
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}
