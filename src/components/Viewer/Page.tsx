import { memo, useEffect, useRef, useSyncExternalStore } from 'react';

// PDF.js text-layer positioning styles. Imported once; harmless if repeated.
import 'pdfjs-dist/web/pdf_viewer.css';

import { getEngine } from '@/core/pdf';
import { getIntrinsicSize, measurePage, subscribePageSizes } from '@/core/pdf/pageSizes';
import { useNearViewport } from '@/hooks/useNearViewport';
import { AnnotationLayer, NotesLayer } from '@/features/annotations';
import { EditLayer, useEditStore } from '@/features/editing';
import { ImageEditLayer } from '@/features/imageedit';
import { OcrTextLayer } from '@/features/ocr';
import { PlacementLayer } from '@/features/placement';
import { SignatureLayer } from '@/features/signatures';
import { TextEditLayer, useTextEditStore } from '@/features/textedit';
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
  // The layout box is the intrinsic size times the scale, so zooming re-lays
  // out from what is already known instead of re-measuring every page in the
  // document. Until this page is measured the value is the document-wide
  // estimate taken from page 1.
  const intrinsic = useSyncExternalStore(subscribePageSizes, () => getIntrinsicSize(pageNumber));
  const dims = intrinsic
    ? { width: intrinsic.width * scale, height: intrinsic.height * scale }
    : null;

  // Two rings, both sharing one observer per (root, margin) across all pages.
  // `visible` gates rasterising; pages that leave it give their canvas back
  // (see the render effect), which is what keeps memory flat on a long scroll.
  //
  // Held back until a size is known, because a page with no size is 0px tall:
  // in the window between mounting and the first measurement landing, every
  // page in the document is stacked a gap apart and dozens of them sit inside
  // the ring at once. Rasterising on that reading would fire a burst of
  // full-page renders for pages that are nowhere near the viewport.
  //
  // Both rings name .folio-viewer (the element PdfViewer scrolls) as the root:
  // rootMargin only grows the root's own rect, and an element root is still
  // intersected with every clipping ancestor between it and the target
  // unexpanded. Left at the implicit viewport root, the scroller's own overflow
  // clips both rings away, so a page 600px or 2400px down the document reads as
  // not intersecting either way and the two rings fire at the same instant.
  const inRasterRing = useNearViewport(wrapperRef, '600px 0px', '.folio-viewer');
  const visible = inRasterRing && dims !== null;
  // `near` is deliberately much wider, and gates the things that should already
  // be in place by the time a page is painted: its true size, and its overlays.
  const near = useNearViewport(wrapperRef, '2400px 0px', '.folio-viewer');

  // A page must not leave the ring while it holds live editing state. Wheel and
  // keyboard scrolling never blur, and no browser fires blur when the focused
  // node is removed, so unmounting the overlays under a caret drops whatever is
  // still uncommitted in the contentEditable: EditLayer rewrites the element
  // from the stored item when it comes back, i.e. to the pre-edit text. Pinning
  // the page is what keeps commit-on-blur (and the edit history it feeds) as it
  // is, where committing on every keystroke would not. Both selectors bail on a
  // null id before touching the item list, so a document with nothing being
  // edited (the usual case) pays a comparison per page per store change.
  const holdsEdit = useEditStore((s) => {
    const liveId = s.focusId ?? s.selectedId;
    return liveId != null && s.edits.some((e) => e.id === liveId && e.pageNumber === pageNumber);
  });
  const holdsTextEdit = useTextEditStore((s) => s.session?.pageIndex === pageNumber - 1);
  const overlays = near || holdsEdit || holdsTextEdit;

  // Measure only pages the user is actually approaching. Measuring on mount
  // instead meant one worker round-trip per page in the document at open, all
  // in one burst, each one pinning a page object in the engine's cache.
  useEffect(() => {
    if (near) measurePage(pageNumber);
  }, [near, pageNumber]);

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
      {/* Mounted on the wide ring rather than for every page in the document.
          Each of these subscribes to its feature store and filters to its own
          page, so mounting all of them everywhere made every edit to any one
          of them O(pages x items), and put a store subscription per layer per
          page on the heap. The ring is much wider than the raster one so a
          layer is always in place well before its page is painted, and it
          always covers the current page, which is what the catchers inside
          EditLayer and ImageEditLayer key off. A page holding live editing
          state stays mounted whether or not it is in the ring (see above). */}
      {overlays && (
        <>
          <OcrTextLayer pageNumber={pageNumber} />
          <AnnotationLayer pageNumber={pageNumber} />
          <NotesLayer pageNumber={pageNumber} />
          <SignatureLayer pageNumber={pageNumber} />
          <EditLayer pageNumber={pageNumber} />
          <TextEditLayer pageNumber={pageNumber} />
          <ImageEditLayer pageNumber={pageNumber} />
          {/* Last, so while a placement is armed it catches the click before the
              overlays underneath it. */}
          <PlacementLayer pageNumber={pageNumber} />
        </>
      )}
    </div>
  );
});
