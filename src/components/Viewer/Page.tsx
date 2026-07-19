import { memo, useEffect, useRef, useState } from 'react';

// PDF.js text-layer positioning styles. Imported once; harmless if repeated.
import 'pdfjs-dist/web/pdf_viewer.css';

import { getEngine } from '@/core/pdf';
import { AnnotationLayer, NotesLayer } from '@/features/annotations';
import { EditLayer } from '@/features/editing';
import { OcrTextLayer } from '@/features/ocr';
import { SignatureLayer } from '@/features/signatures';
import { TextEditLayer } from '@/features/textedit';
import { pluginHost } from '@/plugins';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';
import { DARK_SCHEME_TINT, useThemeStore } from '@/theme/themeStore';

interface PageProps {
  pageNumber: number;
  scale: number;
}

/**
 * A single page: reserves layout space immediately (so scrolling is stable),
 * then rasterises the canvas and text layer once it scrolls near the viewport.
 */
export const Page = memo(function Page({ pageNumber, scale }: PageProps) {
  const docVersion = useDocumentStore((s) => s.docVersion);
  const renderNonce = useViewerStore((s) => s.renderNonce);
  const dark = useThemeStore((s) => s.resolvedTheme === 'dark');
  const darkScheme = useThemeStore((s) => s.darkScheme);
  // In dark mode the page inverts; Green/Amber add a tint. Null tint => Night.
  const tint = dark ? (DARK_SCHEME_TINT[darkScheme] ?? undefined) : undefined;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const formsLayerRef = useRef<HTMLDivElement>(null);
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

  // Track whether the page is near the viewport (prefetch margin). Unlike a
  // one-shot observer, this keeps watching so pages that scroll away can be torn
  // down (see the render effect) — otherwise every page ever viewed keeps its
  // canvas and memory climbs without bound on long documents.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Render once visible; re-render when the scale changes while visible, or
  // when docVersion bumps (an in-place text edit swapped the engine's loaded
  // document for new bytes). Deliberately not gated on `dims`: that only
  // reserves the wrapper's layout box, and renderPage sizes the canvas itself.
  // Waiting for it would mean two render passes per scale change (once with
  // the stale dims, once with the new).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Scrolled away: drop the backing store (0x0 frees the raster memory) and
    // clear the layers so an offscreen page costs almost nothing. It re-renders
    // when it scrolls back into range.
    if (!visible) {
      canvas.width = 0;
      canvas.height = 0;
      textLayerRef.current?.replaceChildren();
      formsLayerRef.current?.replaceChildren();
      return;
    }

    const controller = new AbortController();
    let active = true;
    const engine = getEngine();

    void (async () => {
      const { signal } = controller;
      try {
        await engine.renderPage(pageNumber, {
          scale,
          canvas,
          signal,
          overlayForms: true,
          invert: dark,
          tint,
        });
        if (!active) return;
        if (textLayerRef.current) {
          await engine.renderTextLayer(pageNumber, textLayerRef.current, { scale, signal });
        }
        if (!active) return;
        if (formsLayerRef.current) {
          // Reads doc.annotationStorage off the engine's *current* document
          // proxy, so re-running this after a docVersion bump rebinds the
          // rendered widgets to the new document instead of the stale one.
          await engine.renderAnnotationLayer(pageNumber, formsLayerRef.current, { scale, signal });
        }
        if (!active) return;
        pluginHost.emitPageRender({ pageNumber, scale });
      } catch (error) {
        if (active) console.error(`[folio] failed to render page ${pageNumber}`, error);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [visible, pageNumber, scale, docVersion, renderNonce, dark, tint]);

  return (
    <div
      ref={wrapperRef}
      className="folio-page"
      data-page-number={pageNumber}
      role="group"
      aria-label={`Page ${pageNumber}`}
      style={dims ? { width: dims.width, height: dims.height } : undefined}
    >
      {/* The raster is the visual copy only; the text layer over it is the
          accessible one, so keep the canvas out of the accessibility tree. */}
      <canvas ref={canvasRef} className="folio-page-canvas" aria-hidden="true" />
      <div ref={textLayerRef} className="textLayer folio-text-layer" />
      <div ref={formsLayerRef} className="annotationLayer folio-forms-layer" data-pan-exclude />
      <OcrTextLayer pageNumber={pageNumber} />
      <AnnotationLayer pageNumber={pageNumber} />
      <NotesLayer pageNumber={pageNumber} />
      <SignatureLayer pageNumber={pageNumber} />
      <EditLayer pageNumber={pageNumber} />
      <TextEditLayer pageNumber={pageNumber} />
    </div>
  );
});
