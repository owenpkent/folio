import { useEffect, useRef } from 'react';

import { PageActionBar, PageList } from '@/features/pageops';
import { useViewerStore } from '@/state/viewerStore';
import { isNarrowViewport } from '@/theme/breakpoints';

const THUMB_SCALE = 0.22;
// How long after the user last touched the sidebar scrollbar themselves before
// the follow-current-page effect below is allowed to move it again.
const USER_SCROLL_SUPPRESS_MS = 1200;

export function Thumbnails() {
  const numPages = useViewerStore((s) => s.numPages);
  const currentPage = useViewerStore((s) => s.currentPage);
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
  // visible, and the button exists for every page up front (see PageThumb), so
  // this does not need to wait on its lazy-rendered canvas.
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
    <div className="folio-thumbnails-panel" ref={containerRef}>
      <PageList
        layout="column"
        scrollRoot=".folio-sidebar__body"
        scale={THUMB_SCALE}
        rootMargin="300px 0px"
        onNavigate={() => {
          // On narrow viewports the sidebar is a drawer covering the page;
          // picking a page means "show it", so dismiss the drawer.
          if (isNarrowViewport()) setSidebarOpen(false);
        }}
      />
      <PageActionBar />
    </div>
  );
}
