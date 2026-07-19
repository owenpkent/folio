import { useCallback, useEffect, useRef } from 'react';

import { announce } from '@/a11y/announcer';
import { getEngine } from '@/core/pdf';
import { useContextMenu } from '@/features/contextmenu';
import { focusViewer, setViewerElement } from '@/state/viewerElement';
import { MAX_SCALE, MIN_SCALE, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { EmptyState } from './EmptyState';
import { Page } from './Page';

function announceSpeed(): void {
  announce(`Auto-scroll speed ${useViewerStore.getState().autoScrollSpeed} pixels per second`);
}

/** The scrollable document surface: fit/zoom, lazy pages, current-page tracking. */
export function PdfViewer() {
  const status = useDocumentStore((s) => s.status);
  const error = useDocumentStore((s) => s.error);
  const fingerprint = useDocumentStore((s) => s.info?.fingerprint);

  const numPages = useViewerStore((s) => s.numPages);
  const scale = useViewerStore((s) => s.scale);
  const fitMode = useViewerStore((s) => s.fitMode);
  const handMode = useViewerStore((s) => s.handMode);
  const autoScroll = useViewerStore((s) => s.autoScroll);
  const pendingScrollPage = useViewerStore((s) => s.pendingScrollPage);
  const openContextMenu = useContextMenu((s) => s.openMenu);

  const containerRef = useRef<HTMLDivElement>(null);
  const naturalRef = useRef<{ width: number; height: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

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

  // Publish the scroller so commands can scroll and focus it. Runs on every
  // status change because the element only exists outside the empty state.
  useEffect(() => {
    setViewerElement(containerRef.current);
    return () => setViewerElement(null);
  }, [status]);

  // Focus the viewer once a document is up, so the browser's scroll keys have
  // somewhere to act. Without this, focus stays on <body>, which cannot scroll
  // (.folio-app is overflow:hidden) and every scroll key silently does nothing.
  useEffect(() => {
    if (status === 'ready') focusViewer();
  }, [status, fingerprint]);

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

  // Track the current page from scroll position. Uses viewport-relative rects
  // (so it does not depend on offsetParent) and a capture-phase scroll listener
  // (so it fires whether the viewer element or an ancestor is the scroller, e.g.
  // inside the VS Code webview).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const pages = container.querySelectorAll<HTMLElement>('.folio-page');
      if (pages.length === 0) return;
      const cr = container.getBoundingClientRect();
      const mid = cr.top + container.clientHeight / 2;
      let current = 0;
      for (const el of pages) {
        const r = el.getBoundingClientRect();
        // Skip pages that have not measured yet (0 height), or the last such
        // page would be picked before layout settles.
        if (r.height < 1) continue;
        if (r.top <= mid && r.bottom > mid) {
          current = Number(el.dataset.pageNumber);
          break;
        }
        if (r.bottom <= mid) current = Number(el.dataset.pageNumber);
      }
      const viewer = useViewerStore.getState();
      if (current && current !== viewer.currentPage) viewer.setCurrentPage(current);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    // Capture phase catches scroll from whichever element actually scrolls,
    // since scroll events do not bubble.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    // Recompute when page heights arrive (they are measured asynchronously), so
    // the initial page is correct without waiting for a scroll.
    const pagesEl = container.querySelector('.folio-pages');
    const ro = pagesEl ? new ResizeObserver(onScroll) : null;
    if (pagesEl && ro) ro.observe(pagesEl);
    update();
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true });
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
    // Depend on `status`: the container only exists once the document leaves the
    // empty state, so the listener must (re)attach when that element appears.
  }, [status]);

  // Re-rasterise every page when devicePixelRatio changes — dragging the window
  // to a monitor of a different scale leaves canvases baked at the old ratio,
  // which the OS then stretches (blur). devicePixelRatio has no change event, so
  // use the documented trick: a `(resolution: Xdppx)` media query is a fixed
  // boundary that stops matching the instant dpr changes; re-register a fresh
  // query each time it fires.
  useEffect(() => {
    let mql: MediaQueryList | null = null;
    const onChange = () => {
      useViewerStore.getState().bumpRenderNonce();
      subscribe();
    };
    const subscribe = () => {
      mql?.removeEventListener('change', onChange);
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      mql.addEventListener('change', onChange, { once: true });
    };
    subscribe();
    return () => mql?.removeEventListener('change', onChange);
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

  // Auto-scroll (teleprompter): glide the page down while active. A floating
  // point position is advanced every frame and written straight to scrollTop —
  // browsers keep sub-pixel scroll offsets on HiDPI, so even a slow crawl moves
  // smoothly instead of stepping a whole pixel at a time. Speed is read live so
  // slider/keyboard changes apply without restarting the loop. Panning pauses
  // it, manual scrolling is adopted, and reaching the bottom switches it off.
  useEffect(() => {
    const container = containerRef.current;
    if (!autoScroll || !container) return;

    let raf = 0;
    let last = 0;
    let pos = container.scrollTop; // float scroll position we own between frames
    const step = (ts: number) => {
      if (last === 0) last = ts;
      // Clamp dt so a dropped/backgrounded frame doesn't lurch the page.
      const dt = Math.min((ts - last) / 1000, 0.05);
      last = ts;
      // Hold position while the user is actively panning the page by hand.
      if (!panRef.current && dt > 0) {
        // If the user scrolled by hand (wheel, keys), adopt that position.
        if (Math.abs(container.scrollTop - pos) > 2) pos = container.scrollTop;
        const speed = useViewerStore.getState().autoScrollSpeed;
        pos += speed * dt;
        container.scrollTop = pos;
        const maxTop = container.scrollHeight - container.clientHeight;
        if (pos >= maxTop - 0.5) {
          useViewerStore.getState().setAutoScroll(false);
          announce('Auto-scroll reached the end');
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    // While auto-scrolling, keep speed control and stop on the keyboard.
    const onKey = (e: KeyboardEvent) => {
      // Don't steal keys the command dispatcher already handled (it runs first
      // and preventDefaults its matches), and never fire on a modifier combo —
      // otherwise Ctrl/Cmd+= and Ctrl/Cmd+- would zoom *and* change speed.
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      // Don't steal keys while the user is typing in a field (find box, page box).
      const el = e.target as Element | null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'Escape') {
        useViewerStore.getState().setAutoScroll(false);
        announce('Auto-scroll off');
        e.preventDefault();
      } else if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
        useViewerStore.getState().adjustAutoScrollSpeed(1.3);
        announceSpeed();
        e.preventDefault();
      } else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') {
        useViewerStore.getState().adjustAutoScrollSpeed(1 / 1.3);
        announceSpeed();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, [autoScroll]);

  // Pan the document by dragging: the hand tool with the left button, or the
  // middle button in any mode (like Acrobat / browsers). Interactive overlays
  // keep their own drag behavior; everything else pans.
  const onPanStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const handLeft = handMode && e.button === 0;
    const middle = e.button === 1;
    if (!handLeft && !middle) return;
    const target = e.target as Element;
    if (target.closest('input, textarea, button, a, [data-pan-exclude]')) {
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    e.preventDefault();
    // preventDefault suppresses the browser's focus-on-mousedown, which would
    // otherwise leave the scroll keys dead after a pan.
    container.focus({ preventScroll: true });
    panRef.current = {
      x: e.clientX,
      y: e.clientY,
      left: container.scrollLeft,
      top: container.scrollTop,
    };
    container.classList.add('is-grabbing');
    container.setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    const container = containerRef.current;
    if (!pan || !container) return;
    container.scrollLeft = pan.left - (e.clientX - pan.x);
    container.scrollTop = pan.top - (e.clientY - pan.y);
  };
  const onPanEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panRef.current) return;
    panRef.current = null;
    const container = containerRef.current;
    if (!container) return;
    container.classList.remove('is-grabbing');
    try {
      container.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  };

  // Suppress the browser's middle-click autoscroll widget so our middle-button
  // pan (onPanStart) takes over instead. preventDefault must happen on mousedown
  // for the pointer button; the pointerdown handler above starts the actual pan.
  const onMouseDownCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 1) e.preventDefault();
  };

  // Acrobat-style right-click menu. Leave editable targets (note editor, inputs)
  // to the native menu so copy/paste there still works.
  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as Element;
    if (target.closest('input, textarea, [contenteditable="true"], [data-context-native]')) {
      return;
    }
    e.preventDefault();
    const selectionText = window.getSelection()?.toString() ?? '';
    openContextMenu(e.clientX, e.clientY, selectionText);
  };

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
      className={`folio-viewer${handMode ? ' is-hand' : ''}${autoScroll ? ' is-autoscroll' : ''}`}
      role="region"
      aria-label="Document pages"
      aria-busy={status === 'loading'}
      onMouseDownCapture={onMouseDownCapture}
      onPointerDown={onPanStart}
      onPointerMove={onPanMove}
      onPointerUp={onPanEnd}
      onLostPointerCapture={onPanEnd}
      onContextMenu={onContextMenu}
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
