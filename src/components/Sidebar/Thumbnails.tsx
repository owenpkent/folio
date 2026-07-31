import { useEffect, useRef } from 'react';

import { getEngine } from '@/core/pdf';
import { useNearViewport } from '@/hooks/useNearViewport';
import { useViewerStore } from '@/state/viewerStore';
import { isNarrowViewport } from '@/theme/breakpoints';
import { DARK_SCHEME_TINT, useThemeStore } from '@/theme/themeStore';

const THUMB_SCALE = 0.22;
// How long after the user last touched the sidebar scrollbar themselves before
// the follow-current-page effect below is allowed to move it again.
const USER_SCROLL_SUPPRESS_MS = 1200;

export function Thumbnails() {
  const numPages = useViewerStore((s) => s.numPages);
  const currentPage = useViewerStore((s) => s.currentPage);
  const goToPage = useViewerStore((s) => s.goToPage);
  const setSidebarOpen = useViewerStore((s) => s.setSidebarOpen);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);

  // Don't fight the user: while they're working the sidebar scrollbar by hand
  // (wheel, touch, or grabbing it), suppress the follow effect below.
  //
  // Keyed on numPages, not []: thumbnails is the default sidebar tab, so this
  // component usually mounts with no document open, and the early return below
  // means containerRef is not attached on that render. With an empty dep list
  // the effect would run once against a null ref, find no scroller, and never
  // look again once a PDF actually opened.
  useEffect(() => {
    const scroller = containerRef.current?.closest('.folio-sidebar__body');
    if (!scroller) return;
    const markUserScroll = () => {
      lastUserScrollRef.current = Date.now();
    };
    scroller.addEventListener('wheel', markUserScroll, { passive: true });
    scroller.addEventListener('touchmove', markUserScroll, { passive: true });
    scroller.addEventListener('pointerdown', markUserScroll, { passive: true });
    return () => {
      scroller.removeEventListener('wheel', markUserScroll);
      scroller.removeEventListener('touchmove', markUserScroll);
      scroller.removeEventListener('pointerdown', markUserScroll);
    };
  }, [numPages]);

  // Keep the active thumbnail in view as the current page changes while the
  // document scrolls. 'nearest' does nothing when the thumb is already fully
  // visible, and the button exists for every page up front (see Thumbnail
  // below), so this does not need to wait on its lazy-rendered canvas.
  useEffect(() => {
    if (Date.now() - lastUserScrollRef.current < USER_SCROLL_SUPPRESS_MS) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `.folio-thumb[data-page-number="${currentPage}"]`,
    );
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [currentPage]);

  if (!numPages) {
    return <p className="folio-sidebar__empty">No document open.</p>;
  }

  return (
    <div className="folio-thumbnails" ref={containerRef}>
      {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
        <Thumbnail
          key={pageNumber}
          pageNumber={pageNumber}
          active={pageNumber === currentPage}
          onSelect={() => {
            goToPage(pageNumber);
            // On narrow viewports the sidebar is a drawer covering the page;
            // picking a page means "show it", so dismiss the drawer.
            if (isNarrowViewport()) setSidebarOpen(false);
          }}
        />
      ))}
    </div>
  );
}

interface ThumbnailProps {
  pageNumber: number;
  active: boolean;
  onSelect: () => void;
}

function Thumbnail({ pageNumber, active, onSelect }: ThumbnailProps) {
  const dark = useThemeStore((s) => s.resolvedTheme === 'dark');
  const darkScheme = useThemeStore((s) => s.darkScheme);
  // Same mapping as Page.tsx: dark mode inverts the thumbnail; Green/Amber add
  // a tint. Null tint => Night.
  const tint = dark ? (DARK_SCHEME_TINT[darkScheme] ?? undefined) : undefined;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The root must be the element that actually scrolls (.folio-sidebar__body),
  // not the flex column inside it. With an element root, IntersectionObserver
  // clips only against containers *between* target and root, never above it, so
  // rooting this at the unclipped .folio-thumbnails made every thumb in the
  // document report as intersecting on the first observation, which rasterised
  // every page at once on open. Same element the scroll effect above targets.
  //
  // Two-way (rather than latching on first sight, like it used to) so thumbnails
  // that scroll away drop their backing store again; otherwise a long document
  // accumulates a canvas per page visited and never gives one back.
  const render = useNearViewport(buttonRef, '300px 0px', '.folio-sidebar__body');

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
        scale: THUMB_SCALE,
        canvas,
        signal: controller.signal,
        invert: dark,
        tint,
      })
      .catch(() => {});
    return () => controller.abort();
  }, [render, pageNumber, dark, tint]);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-page-number={pageNumber}
      className={`folio-thumb${active ? ' is-active' : ''}`}
      aria-label={`Go to page ${pageNumber}`}
      title={`Go to page ${pageNumber}`}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
    >
      <span className="folio-thumb__frame">
        <canvas ref={canvasRef} className="folio-thumb__canvas" />
      </span>
      <span className="folio-thumb__num">{pageNumber}</span>
    </button>
  );
}
