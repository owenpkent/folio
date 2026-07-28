import { useEffect, useState, type MouseEvent, type PointerEvent } from 'react';

import { announce } from '@/a11y/announcer';
import { Icon, pushToast } from '@/components/common';
import { getEngine, type PageViewport } from '@/core/pdf';
import { pickImageFile } from '@/features/editing/commands';
import { reloadEditedBytes } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';
import { formWidgetAt } from '@/state/formsLayer';
import { useViewerStore } from '@/state/viewerStore';

import { getLocatedImages } from './locateCache';
import { commitImageEdit, firstEditableImage, ImageEditError, matchImageToTarget } from './mutate';
import { useImageEditStore } from './store';
import type { ImageEditRect, LocatedImage, SelectedImage } from './types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** The .folio-page ancestor's CSS rect, the same lookup EditLayer.tsx uses for drag/resize deltas. */
const pageRectFrom = (el: Element | null) =>
  el?.closest('.folio-page')?.getBoundingClientRect() ?? null;

/** Whether two CSS-pixel rects differ by more than a fraction of a pixel (i.e. a real drag, not just a click). */
function rectsDiffer(a: ImageEditRect, b: ImageEditRect): boolean {
  const EPS = 0.5;
  return (
    Math.abs(a.x - b.x) > EPS ||
    Math.abs(a.y - b.y) > EPS ||
    Math.abs(a.width - b.width) > EPS ||
    Math.abs(a.height - b.height) > EPS
  );
}

/** The topmost (last-painted) located image whose rect contains (x, y), in PDF user space. */
function findImageAt(images: LocatedImage[], x: number, y: number): LocatedImage | undefined {
  let found: LocatedImage | undefined;
  for (const image of images) {
    const { rect } = image;
    if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
      found = image;
    }
  }
  return found;
}

/** rect (PDF user space, bottom-left origin) to a CSS-pixel rect, the way TextEditLayer.tsx converts an item's box. */
function pdfRectToCssRect(viewport: PageViewport, rect: ImageEditRect): ImageEditRect {
  const vr = viewport.convertToViewportRectangle([
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y + rect.height,
  ]) as [number, number, number, number];
  return {
    x: Math.min(vr[0], vr[2]),
    y: Math.min(vr[1], vr[3]),
    width: Math.abs(vr[2] - vr[0]),
    height: Math.abs(vr[3] - vr[1]),
  };
}

/** The inverse of pdfRectToCssRect: a CSS-pixel rect back to PDF user space, for committing a drag/resize. */
function cssRectToPdfRect(viewport: PageViewport, rect: ImageEditRect): ImageEditRect {
  const [x0, y0] = viewport.convertToPdfPoint(rect.x, rect.y) as [number, number];
  const [x1, y1] = viewport.convertToPdfPoint(rect.x + rect.width, rect.y + rect.height) as [
    number,
    number,
  ];
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** Deselect the selected image on outside-click or Escape (mounted only while this page holds the selection). */
function useDeselectOnOutside(active: boolean): void {
  const select = useImageEditStore((s) => s.select);
  useEffect(() => {
    if (!active) return;
    const onDown = (ev: globalThis.PointerEvent) => {
      const t = ev.target as Element | null;
      if (!t?.closest?.('.folio-imageedit-selected')) select(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') select(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, select]);
}

/**
 * Overlay for selecting, moving, resizing, replacing, and deleting an image
 * XObject already drawn on a page. Only interactive while the "Edit images"
 * tool (store.active) is on; the page's own canvas already shows the image
 * itself, so unlike features/editing this layer never renders a bitmap of
 * its own, only selection chrome. See ./types.ts for the overall pipeline.
 */
export function ImageEditLayer({ pageNumber }: { pageNumber: number }) {
  const active = useImageEditStore((s) => s.active);
  const selected = useImageEditStore((s) => s.selected);
  const select = useImageEditStore((s) => s.select);
  const scale = useViewerStore((s) => s.scale);
  const currentPage = useViewerStore((s) => s.currentPage);
  const docVersion = useDocumentStore((s) => s.docVersion);
  const pageIndex = pageNumber - 1;
  const isThisPage = selected != null && selected.pageIndex === pageIndex;
  // The catcher is a real focusable button covering the whole page, so mounting
  // one per page would add a tab stop per page (all with the same label) to a
  // long document. Only the page in view gets one, which also makes the
  // keyboard fallback below unambiguous about which page's "first editable
  // image" it means. Same gating MarkPlaceCatcher uses in
  // features/editing/EditLayer.tsx.
  const showCatcher = active && pageNumber === currentPage;

  const [viewport, setViewport] = useState<PageViewport | null>(null);
  // The full LocatedImage the current selection resolves to, refreshed
  // whenever the selection or the document changes: the store only keeps the
  // lightweight target (see SelectedImage), but rendering the resize handle
  // needs to know transformable and the natural pixel aspect ratio too.
  const [selectedInfo, setSelectedInfo] = useState<LocatedImage | null>(null);
  // A CSS-pixel rect overriding selectedInfo's own for the duration of an
  // active drag or resize gesture, so every pointermove is a cheap local
  // update rather than a full serialize-mutate-reload round trip (that only
  // happens once, on pointerup; see startDrag/startResize below).
  const [previewCssRect, setPreviewCssRect] = useState<ImageEditRect | null>(null);

  useDeselectOnOutside(isThisPage);

  useEffect(() => {
    let cancelled = false;
    void getEngine()
      .getPageViewport(pageNumber, scale)
      .then((vp) => {
        if (!cancelled) setViewport(vp);
      });
    return () => {
      cancelled = true;
    };
  }, [pageNumber, scale]);

  useEffect(() => {
    if (!isThisPage) {
      setSelectedInfo(null);
      return;
    }
    let cancelled = false;
    void getLocatedImages(docVersion, pageIndex).then((images) => {
      if (!cancelled) setSelectedInfo(matchImageToTarget(images, selected) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [isThisPage, selected, pageIndex, docVersion]);

  const tryClickAt = async (pageEl: HTMLElement, clientX: number, clientY: number) => {
    const pageRect = pageEl.getBoundingClientRect();
    const cssX = clientX - pageRect.left;
    const cssY = clientY - pageRect.top;
    const vp = viewport ?? (await getEngine().getPageViewport(pageNumber, scale));
    const [pdfX, pdfY] = vp.convertToPdfPoint(cssX, cssY) as [number, number];

    const images = await getLocatedImages(useDocumentStore.getState().docVersion, pageIndex);
    const image = findImageAt(images, pdfX, pdfY);
    if (!image) return;

    // Select it either way, including when it is not editable (e.g. found
    // inside a Form XObject; see mutate.ts's header comment): the click did
    // land on a real image, and showing that is the point. A toast with no
    // visible selection reads the same as a missed click -- the exact
    // confusion TextEditLayer.tsx's reporting of a blocked run avoids, which
    // this mirrors: select, then explain why if there is a reason to.
    select({ pageIndex, streamIndex: image.streamIndex, name: image.name, rect: image.rect });
    if (!image.editable) {
      pushToast(image.blockedReason ?? 'This image cannot be edited', 'error');
    }
  };

  /**
   * Keyboard fallback for the catcher below: activating a button from the
   * keyboard (Enter/Space) reports `detail === 0` on the click event (the same
   * signal MarkPlaceCatcher, features/editing/EditLayer.tsx, uses), and
   * clientX/clientY are meaningless in that case -- 0, not a page position --
   * so there is nothing to hit-test. Select the first editable image on the
   * page instead of hit-testing (0, 0), which would land on whatever happens
   * to sit at the viewport's corner; say so if there is none, rather than
   * leaving the keyboard user with no feedback at all.
   */
  const selectFirstEditableImage = async () => {
    const images = await getLocatedImages(useDocumentStore.getState().docVersion, pageIndex);
    const image = firstEditableImage(images);
    if (!image) {
      announce('No editable image on this page.', true);
      return;
    }
    select({ pageIndex, streamIndex: image.streamIndex, name: image.name, rect: image.rect });
  };

  const handleCatcherClick = (e: MouseEvent<HTMLButtonElement>) => {
    // Keyboard activation needs neither a page element nor a pointer
    // position, so it is handled up front rather than after the pageEl guard
    // below (which exists only for the pointer path).
    if (e.detail === 0) {
      void selectFirstEditableImage();
      return;
    }
    const pageEl = e.currentTarget.closest<HTMLElement>('.folio-page');
    if (!pageEl) return;
    // This catcher sits above the forms layer at a higher z-index (see
    // formsLayer.ts), so without this check it would swallow a click meant
    // for a checkbox or field instead of the image behind it. Unlike the
    // check-mark stamp (EditLayer.tsx), this tool has no doc-stated reason to
    // prefer covering a live field -- a field and an image are unrelated
    // content that only happen to overlap -- so the field stays reachable the
    // same way it would with no tool armed at all.
    const widget = formWidgetAt(e.clientX, e.clientY);
    if (widget) {
      widget.focus();
      widget.click();
      return;
    }
    void tryClickAt(pageEl, e.clientX, e.clientY);
  };

  /** Serialize, mutate, and live-reload: the same commit path in-place text edits use. */
  const commitMove = async (rect: ImageEditRect, current: SelectedImage) => {
    try {
      const bytes = await getEngine().saveDocument();
      const result = await commitImageEdit({
        pdfBytes: bytes,
        pageIndex: current.pageIndex,
        target: { streamIndex: current.streamIndex, name: current.name, rect: current.rect },
        action: { kind: 'move', rect },
      });
      // Keep the same image selected at its new rect (rather than waiting on
      // the docVersion-triggered re-fetch below) so there is no visible gap
      // once previewCssRect clears in `finally`.
      select({ ...current, rect });
      await reloadEditedBytes(result);
    } catch (error) {
      const message = error instanceof ImageEditError ? error.message : 'Could not move this image';
      pushToast(message, 'error');
    } finally {
      setPreviewCssRect(null);
    }
  };

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    // selectedInfo?.editable: selecting a non-editable image (see tryClickAt
    // above) now reaches here too, and without this the drag would run to
    // completion visually, then revert with a toast on pointerup once
    // commitMove's own editable check fails it -- a more confusing dead end
    // than simply not starting the drag.
    if (e.button !== 0 || !viewport || !selected || !selectedInfo?.transformable) return;
    if (!selectedInfo.editable) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startCss = previewCssRect ?? pdfRectToCssRect(viewport, selected.rect);
    let latest = startCss;

    const onMove = (ev: globalThis.PointerEvent) => {
      // Clamped to the page, the same way EditLayer.tsx clamps a placed
      // overlay's drag: dragging an embedded image off the page edge would
      // commit a placement with no way back to it except undo.
      latest = {
        ...startCss,
        x: clamp(startCss.x + (ev.clientX - startX), 0, pageRect.width - startCss.width),
        y: clamp(startCss.y + (ev.clientY - startY), 0, pageRect.height - startCss.height),
      };
      setPreviewCssRect(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      // A click with no real movement should not round-trip a save/reload
      // (and would otherwise wrap the operator in a no-op q/cm/Q for nothing).
      if (viewport && selected && rectsDiffer(latest, startCss)) {
        void commitMove(cssRectToPdfRect(viewport, latest), selected);
      } else {
        setPreviewCssRect(null);
      }
    };
    // An interrupted touch (a system gesture taking over, say) fires
    // pointercancel and never pointerup, which would leave these listeners
    // attached and the preview rect stuck until the next press.
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setPreviewCssRect(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    // selectedInfo.editable: see startDrag's identical guard above.
    if (e.button !== 0 || !viewport || !selected || !selectedInfo?.transformable) return;
    if (!selectedInfo.editable) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startCss = previewCssRect ?? pdfRectToCssRect(viewport, selected.rect);
    // Lock the image's own natural pixel aspect ratio while resizing (CSS
    // pixels scale isotropically with PDF points here, so this ratio holds
    // in either space); mirrors EditLayer.tsx's ImageItem, which locks the
    // currently-displayed aspect instead since a placed image has no
    // separate "natural" size of its own.
    const aspect = selectedInfo.naturalWidth / (selectedInfo.naturalHeight || 1);
    let latest = startCss;

    const onMove = (ev: globalThis.PointerEvent) => {
      const dxFrac = (ev.clientX - startX) / pageRect.width;
      let width = clamp(startCss.width + dxFrac * pageRect.width, 8, pageRect.width - startCss.x);
      let height = width / aspect;
      // Keep the box from growing past the page's bottom edge too, the same
      // cross-axis clamp EditLayer.tsx's own aspect-locked resize applies.
      if (startCss.y + height > pageRect.height) {
        height = pageRect.height - startCss.y;
        width = height * aspect;
      }
      latest = { ...startCss, width, height };
      setPreviewCssRect(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (viewport && selected && rectsDiffer(latest, startCss)) {
        void commitMove(cssRectToPdfRect(viewport, latest), selected);
      } else {
        setPreviewCssRect(null);
      }
    };
    // See startDrag's own pointercancel handler above.
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      setPreviewCssRect(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  const handleReplace = async () => {
    if (!selected) return;
    const picked = await pickImageFile();
    if (!picked) return;
    try {
      const bytes = await getEngine().saveDocument();
      const result = await commitImageEdit({
        pdfBytes: bytes,
        pageIndex: selected.pageIndex,
        target: { streamIndex: selected.streamIndex, name: selected.name, rect: selected.rect },
        action: { kind: 'replace', dataUrl: picked.dataUrl, mime: picked.mime },
      });
      await reloadEditedBytes(result);
      // The operator now draws a freshly embedded image under a brand-new
      // resource name (see commitImageEdit's replace path), so `selected`'s
      // own name is stale: re-resolve by rect (name-agnostic, since that's
      // exactly what changed) and update it, rather than leaving the image
      // selected but unable to re-match itself for a further move or delete.
      const refreshed = await getLocatedImages(
        useDocumentStore.getState().docVersion,
        selected.pageIndex,
      );
      const stillHere = refreshed.find(
        (img) =>
          img.streamIndex === selected.streamIndex &&
          Math.hypot(img.rect.x - selected.rect.x, img.rect.y - selected.rect.y) < 2,
      );
      if (stillHere) select({ ...selected, name: stillHere.name });
    } catch (error) {
      const message =
        error instanceof ImageEditError ? error.message : 'Could not replace this image';
      pushToast(message, 'error');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    try {
      const bytes = await getEngine().saveDocument();
      const result = await commitImageEdit({
        pdfBytes: bytes,
        pageIndex: selected.pageIndex,
        target: { streamIndex: selected.streamIndex, name: selected.name, rect: selected.rect },
        action: { kind: 'delete' },
      });
      select(null);
      await reloadEditedBytes(result);
    } catch (error) {
      const message =
        error instanceof ImageEditError ? error.message : 'Could not delete this image';
      pushToast(message, 'error');
    }
  };

  const cssRect =
    viewport && isThisPage && selected
      ? (previewCssRect ?? pdfRectToCssRect(viewport, selected.rect))
      : null;

  return (
    <div className="folio-imageedit-layer" data-pan-exclude>
      {showCatcher && (
        <button
          type="button"
          className="folio-imageedit-hit"
          aria-label="Click an image on the page to select it, or press Enter to select the first editable image"
          onClick={handleCatcherClick}
        />
      )}
      {cssRect && (
        <div
          className="folio-edit folio-edit--image is-selected folio-imageedit-selected"
          style={{ left: cssRect.x, top: cssRect.y, width: cssRect.width, height: cssRect.height }}
        >
          <div
            className="folio-imageedit__surface"
            style={{
              cursor: selectedInfo?.transformable && selectedInfo?.editable ? 'move' : 'default',
            }}
            onPointerDown={startDrag}
          />
          <div className="folio-edit__inspector" onPointerDown={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="folio-imageedit__replace"
              onClick={() => void handleReplace()}
            >
              Replace image…
            </button>
          </div>
          <button
            type="button"
            className="folio-edit__delete"
            aria-label="Delete image"
            title="Delete image"
            onClick={() => void handleDelete()}
          >
            <Icon name="x" size={13} />
          </button>
          {selectedInfo?.transformable && selectedInfo?.editable && (
            <span
              className="folio-edit__resize"
              aria-hidden="true"
              title="Drag to resize"
              onPointerDown={startResize}
            />
          )}
        </div>
      )}
    </div>
  );
}
