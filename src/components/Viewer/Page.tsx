import { memo, useEffect, useRef, useState } from 'react';

// PDF.js text-layer positioning styles. Imported once; harmless if repeated.
import 'pdfjs-dist/web/pdf_viewer.css';

import { getEngine } from '@/core/pdf';
import { AnnotationLayer } from '@/features/annotations';
import { pluginHost } from '@/plugins';

interface PageProps {
  pageNumber: number;
  scale: number;
}

/**
 * A single page: reserves layout space immediately (so scrolling is stable),
 * then rasterises the canvas and text layer once it scrolls near the viewport.
 */
export const Page = memo(function Page({ pageNumber, scale }: PageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const [visible, setVisible] = useState(false);

  // Measure at the current scale so the page box reserves the right space.
  useEffect(() => {
    let cancelled = false;
    getEngine()
      .getPageDimensions(pageNumber, scale)
      .then((d) => {
        if (!cancelled) setDims(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pageNumber, scale]);

  // Flag when the page nears the viewport (prefetch margin).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render once visible; re-render when the scale changes while visible.
  useEffect(() => {
    if (!visible || !dims) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = new AbortController();
    let active = true;
    const engine = getEngine();

    void (async () => {
      try {
        await engine.renderPage(pageNumber, { scale, canvas, signal: controller.signal });
        if (!active) return;
        if (textLayerRef.current) {
          await engine.renderTextLayer(pageNumber, textLayerRef.current, scale);
        }
        pluginHost.emitPageRender({ pageNumber, scale });
      } catch (error) {
        if (active) console.error(`[folio] failed to render page ${pageNumber}`, error);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [visible, dims, pageNumber, scale]);

  return (
    <div
      ref={wrapperRef}
      className="folio-page"
      data-page-number={pageNumber}
      role="group"
      aria-label={`Page ${pageNumber}`}
      style={dims ? { width: dims.width, height: dims.height } : undefined}
    >
      <canvas ref={canvasRef} className="folio-page-canvas" />
      <div ref={textLayerRef} className="textLayer folio-text-layer" />
      <AnnotationLayer pageNumber={pageNumber} />
    </div>
  );
});
