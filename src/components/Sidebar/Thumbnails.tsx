import { useEffect, useRef, useState } from 'react';

import { getEngine } from '@/core/pdf';
import { useViewerStore } from '@/state/viewerStore';
import { isNarrowViewport } from '@/theme/breakpoints';

const THUMB_SCALE = 0.22;

export function Thumbnails() {
  const numPages = useViewerStore((s) => s.numPages);
  const currentPage = useViewerStore((s) => s.currentPage);
  const goToPage = useViewerStore((s) => s.goToPage);
  const setSidebarOpen = useViewerStore((s) => s.setSidebarOpen);

  if (!numPages) {
    return <p className="folio-sidebar__empty">No document open.</p>;
  }

  return (
    <div className="folio-thumbnails">
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [render, setRender] = useState(false);

  useEffect(() => {
    const el = buttonRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setRender(true);
            observer.disconnect();
            break;
          }
        }
      },
      { root: el.closest('.folio-thumbnails'), rootMargin: '300px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!render) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    getEngine()
      .renderPage(pageNumber, { scale: THUMB_SCALE, canvas, signal: controller.signal })
      .catch(() => {});
    return () => controller.abort();
  }, [render, pageNumber]);

  return (
    <button
      ref={buttonRef}
      type="button"
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
