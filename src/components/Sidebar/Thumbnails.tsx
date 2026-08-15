import { useEffect, useRef } from 'react';

import { Button, Icon } from '@/components/common';
import { openCombineModal } from '@/features/combine';
import { PageActionBar, PageList, usePageOpsStore } from '@/features/pageops';
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
  // The organizer modal mounts its own PageActionBar in its footer while it
  // is open. Mounting this one too would put two "Actions for the selected
  // pages" groups and two role="status" counts in the accessibility tree at
  // once, both announcing the same selection.
  const organizing = usePageOpsStore((s) => s.organizing);
  const containerRef = useRef<HTMLDivElement>(null);
  const lastUserScrollRef = useRef(0);

  // Don't fight the user: while they're working the sidebar scrollbar by hand
  // (wheel, touch, or grabbing it), suppress the follow effect below.
  //
  // Keyed on numPages, not []: thumbnails is the default sidebar tab, so this
  // component usually mounts with no document open, and the scrolling element
  // this looks for does not exist until one is. With an empty dep list the
  // effect would run once, find no scroller, and never look again once a PDF
  // actually opened.
  useEffect(() => {
    const scroller = containerRef.current?.querySelector('.folio-thumbnails-scroll');
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

  return (
    <div className="folio-thumbnails-panel" ref={containerRef}>
      {/* Combining is a page-level operation, so it lives with the pages
          rather than only in the File menu. Above the list and outside the
          scrolling box: it acts on the document as a whole, not on whatever
          page happens to be scrolled into view, and it stays put while the
          list moves. Deliberately not gated on a document being open -- the
          combine modal takes its inputs from a picker, so building a new PDF
          out of several files is one of the few things worth doing here from
          an empty viewer. */}
      <div className="folio-thumbnails-toolbar">
        <Button onClick={() => void openCombineModal()}>
          <Icon name="combine" size={16} />
          Combine PDFs…
        </Button>
      </div>
      {!numPages ? (
        <p className="folio-sidebar__empty">No document open.</p>
      ) : (
        <>
          {/*
           * The scrolling region is its own element, separate from the action
           * bar below: the action bar used to live inside .folio-sidebar__body
           * (the scrolling element) and rely on position: sticky to stay visible
           * at the bottom, which means floating *over* whatever thumbnail
           * happened to be scrolled to that spot. That is fine for a bar with
           * nothing clickable behind it, and wrong for one sitting over a
           * checkbox: whichever element paints on top also receives the click,
           * so a click aimed at a covered checkbox lands on the bar instead.
           * Giving the bar its own row below the scrolling list, rather than a
           * layer on top of it, means there is no card it can ever cover.
           */}
          <div className="folio-thumbnails-scroll">
            <PageList
              layout="column"
              scrollRoot=".folio-thumbnails-scroll"
              scale={THUMB_SCALE}
              rootMargin="300px 0px"
              onNavigate={() => {
                // On narrow viewports the sidebar is a drawer covering the page;
                // picking a page means "show it", so dismiss the drawer.
                if (isNarrowViewport()) setSidebarOpen(false);
              }}
            />
          </div>
          {!organizing && <PageActionBar />}
        </>
      )}
    </div>
  );
}
