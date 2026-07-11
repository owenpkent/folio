import { useCallback, useEffect, useRef } from 'react';

import { getEngine } from '@/core/pdf';
import { MAX_SCALE, MIN_SCALE, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { EmptyState } from './EmptyState';
import { Page } from './Page';

/** The scrollable document surface: fit/zoom, lazy pages, current-page tracking. */
export function PdfViewer() {
  const status = useDocumentStore((s) => s.status);
  const error = useDocumentStore((s) => s.error);
  const fingerprint = useDocumentStore((s) => s.info?.fingerprint);

  const numPages = useViewerStore((s) => s.numPages);
  const scale = useViewerStore((s) => s.scale);
  const fitMode = useViewerStore((s) => s.fitMode);
  const pendingScrollPage = useViewerStore((s) => s.pendingScrollPage);

  const containerRef = useRef<HTMLDivElement>(null);
  const naturalRef = useRef<{ width: number; height: number } | null>(null);

  const recomputeFit = useCallback(() => {
    const container = containerRef.current;
    const natural = naturalRef.current;
    if (!container || !natural) return;
    if (useViewerStore.getState().fitMode === 'custom') return;

    const style = getComputedStyle(container);
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const availWidth = container.clientWidth - padX;
    const availHeight = container.clientHeight - padY;

    const mode = useViewerStore.getState().fitMode;
    let next = 1;
    if (mode === 'width') next = availWidth / natural.width;
    else if (mode === 'page')
      next = Math.min(availWidth / natural.width, availHeight / natural.height);

    next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    // Set scale directly so we don't flip fitMode back to "custom".
    useViewerStore.setState({ scale: next });
  }, []);

  // Grab the natural (100%) size of page 1 when a document loads.
  useEffect(() => {
    naturalRef.current = null;
    if (status !== 'ready') return;
    let cancelled = false;
    getEngine()
      .getPageDimensions(1, 1)
      .then((d) => {
        if (cancelled) return;
        naturalRef.current = d;
        recomputeFit();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status, fingerprint, recomputeFit]);

  // Recompute the fit scale when the fit mode changes or the container resizes.
  useEffect(() => {
    recomputeFit();
  }, [fitMode, recomputeFit]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => recomputeFit());
    observer.observe(container);
    return () => observer.disconnect();
  }, [recomputeFit]);

  // Track the current page from scroll position.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const pages = container.querySelectorAll<HTMLElement>('.folio-page');
        const mid = container.scrollTop + container.clientHeight / 2;
        let current = 1;
        for (const el of pages) {
          const top = el.offsetTop;
          const bottom = top + el.offsetHeight;
          if (mid >= top && mid < bottom) {
            current = Number(el.dataset.pageNumber);
            break;
          }
          if (mid >= bottom) current = Number(el.dataset.pageNumber);
        }
        const viewer = useViewerStore.getState();
        if (current && current !== viewer.currentPage) viewer.setCurrentPage(current);
      });
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Honor scroll-to-page requests (outline clicks, page box, next/prev).
  useEffect(() => {
    if (pendingScrollPage == null) return;
    const container = containerRef.current;
    const el = container?.querySelector<HTMLElement>(
      `.folio-page[data-page-number="${pendingScrollPage}"]`,
    );
    if (container && el) {
      container.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: 'smooth' });
    }
    useViewerStore.getState().clearPendingScroll();
  }, [pendingScrollPage]);

  if (status === 'empty') return <EmptyState />;
  if (status === 'error') {
    return (
      <div className="folio-viewer-message" role="alert">
        Could not open document{error ? `: ${error}` : ''}.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="folio-viewer"
      role="region"
      aria-label="Document pages"
      aria-busy={status === 'loading'}
      // A scrollable region must be keyboard focusable so it can be scrolled
      // with the arrow keys (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      {status === 'loading' && <div className="folio-viewer-message">Opening document…</div>}
      <div className="folio-pages">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNumber) => (
          <Page key={`${fingerprint}-${pageNumber}`} pageNumber={pageNumber} scale={scale} />
        ))}
      </div>
    </div>
  );
}
