import { memo, useEffect, useRef, useSyncExternalStore } from 'react';

import { getEngine } from '@/core/pdf';
import { getIntrinsicSize, subscribePageSizes } from '@/core/pdf/pageSizes';
import { useNearViewport } from '@/hooks/useNearViewport';
import { useDocumentStore } from '@/state/documentStore';
import { DARK_SCHEME_TINT, useThemeStore } from '@/theme/themeStore';

import { usePageOpsStore } from './store';

interface PageThumbProps {
  pageNumber: number;
  /** The page the viewer is currently showing. */
  active: boolean;
  /** True while a drag is in flight anywhere in the list. */
  anyDragging: boolean;
  /** Render scale for the canvas. */
  scale: number;
  /** Selector for the scrolling ancestor, so lazy rasterisation clips right. */
  scrollRoot: string;
  /** How far beyond that scroller to start rasterising. */
  rootMargin: string;
  /** Toggle this page's selection; `range` means extend from the anchor. */
  onSelect(pageNumber: number, range: boolean): void;
  onActivate(pageNumber: number, event: React.MouseEvent): void;
  onPointerDown(event: React.PointerEvent, pageNumber: number): void;
  onKeyDown(event: React.KeyboardEvent, pageNumber: number): void;
}

/**
 * One page in a page list: its raster, its number, and a checkbox for picking
 * it out.
 *
 * Shared by the thumbnails sidebar and the organizer so both behave the same.
 * The checkbox is a sibling of the navigation button rather than sitting inside
 * it, because a control nested in a button is neither valid nor separately
 * clickable.
 *
 * Memoised, and it reads its own selected state rather than taking it as a
 * prop, so that dragging over a long document re-renders the drop indicator
 * and nothing else. Every handler prop has to stay referentially stable for
 * that to hold, which is why they all take the page number rather than closing
 * over it.
 */
export const PageThumb = memo(function PageThumb({
  pageNumber,
  active,
  anyDragging,
  scale,
  scrollRoot,
  rootMargin,
  onSelect,
  onActivate,
  onPointerDown,
  onKeyDown,
}: PageThumbProps) {
  const selected = usePageOpsStore((s) => s.selection.has(pageNumber));
  // A drag carries the whole selection, so every selected page lifts together.
  const dragging = anyDragging && selected;
  const dark = useThemeStore((s) => s.resolvedTheme === 'dark');
  const darkScheme = useThemeStore((s) => s.darkScheme);
  // Same mapping as Page.tsx: dark mode inverts the thumbnail; Green/Amber add
  // a tint. Null tint => Night.
  const tint = dark ? (DARK_SCHEME_TINT[darkScheme] ?? undefined) : undefined;
  // A page operation swaps the engine's document without any page number
  // changing, so nothing else here would tell the canvas that its page is now
  // a different page.
  const docVersion = useDocumentStore((s) => s.docVersion);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Reserve the frame's box from the page's shape before anything is rendered
  // into it, the way Page.tsx reserves its own. Without it the zeroed canvas of
  // an unrendered thumb is 0x0, every thumb collapses to its page number, and
  // dozens fit inside the observer's ring on first paint: dozens of renderPage
  // calls at once, with pdf.js decoding each page's embedded images at native
  // resolution however small the scale is. The heights then grew as the thumbs
  // rendered, walking the scroll position as they went.
  const intrinsic = useSyncExternalStore(subscribePageSizes, () => getIntrinsicSize(pageNumber));

  // The root must be the element that actually scrolls, not the container
  // inside it. With an element root, IntersectionObserver clips only against
  // containers *between* target and root, never above it, so rooting this at an
  // unclipped list made every thumb report as intersecting on first observation,
  // rasterising every page in the document at once.
  //
  // Two-way rather than latching on first sight, so thumbnails that scroll away
  // drop their backing store again; otherwise a long document accumulates a
  // canvas per page visited and never gives one back.
  const render = useNearViewport(buttonRef, rootMargin, scrollRoot);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Scrolled away: 0x0 frees the raster memory, matching Page.tsx.
    if (!render) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    const controller = new AbortController();
    getEngine()
      .renderPage(pageNumber, {
        scale,
        canvas,
        signal: controller.signal,
        invert: dark,
        tint,
      })
      .catch(() => {});
    return () => controller.abort();
  }, [render, pageNumber, dark, tint, scale, docVersion]);

  return (
    <div
      className={`folio-page-card${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`}
      data-page-number={pageNumber}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select page ${pageNumber}`}
        className="folio-page-card__check"
        // A button rather than a checkbox input so the handler can see the
        // shift key, which is what turns a click into a range.
        onClick={(event) => onSelect(pageNumber, event.shiftKey)}
      />
      <button
        ref={buttonRef}
        type="button"
        data-page-number={pageNumber}
        className={`folio-thumb${active ? ' is-active' : ''}`}
        aria-label={`Go to page ${pageNumber}`}
        title={`Go to page ${pageNumber}`}
        aria-current={active ? 'page' : undefined}
        draggable={false}
        onClick={(event) => onActivate(pageNumber, event)}
        onPointerDown={(event) => onPointerDown(event, pageNumber)}
        onKeyDown={(event) => onKeyDown(event, pageNumber)}
      >
        <span
          className="folio-thumb__frame"
          style={
            intrinsic ? { aspectRatio: `${intrinsic.width} / ${intrinsic.height}` } : undefined
          }
        >
          <canvas ref={canvasRef} className="folio-thumb__canvas" />
        </span>
        <span className="folio-thumb__num">{pageNumber}</span>
      </button>
    </div>
  );
});
