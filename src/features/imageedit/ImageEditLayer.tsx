import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import { announce } from '@/a11y/announcer';
import { useNudgeKeys, type NudgeRect } from '@/a11y/useNudgeKeys';
import { Icon, pushToast } from '@/components/common';
import { convertToViewportRectangle, getEngine, type PageViewport } from '@/core/pdf';
import { pickImageFile } from '@/features/editing/commands';
// Store only, not the feature barrel: see actions.ts's own comment on the
// same import for why (pulls in UI this layer has no business importing).
import { usePageOpsStore } from '@/features/pageops/store';
import { useTextEditStore } from '@/features/textedit/store';
import { reloadEditedBytes } from '@/state/actions';
import {
  documentMutationBusyMessage,
  documentMutationWouldBlock,
  DOCUMENT_MUTATION_BUSY_TITLE,
  useDocumentMutationBlocked,
  withDocumentMutation,
} from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';
import { formWidgetAt } from '@/state/formsLayer';
import { useViewerStore } from '@/state/viewerStore';

import { getLocatedImages } from './locateCache';
import { commitImageEdit, firstEditableImage, ImageEditError, matchImageToTarget } from './mutate';
import { useImageEditStore } from './store';
import type { ImageEditRect, LocatedImage, SelectedImage } from './types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Page ops and text edit each keep their own undo stack bound to Mod+z (see
 * pageops/operations.ts's swapInDocument and textedit/commands.ts), and each
 * already invalidates the other's on a commit of its own. Image editing has
 * no undo stack of its own to protect the same way, but a commit here still
 * has to invalidate both of theirs: once this reload lands, their snapshots
 * describe bytes from before it, and undoing with either would silently
 * discard this image edit, with no signal that anything was lost.
 *
 * Called BEFORE the reload, never after it, which is the ordering pageops'
 * own swapInDocument uses and for the same reason: reloadEditedBytes calls
 * engine.loadDocument, which can reject after pdf.js has already detached the
 * previous document and taken the new bytes. An invalidate sitting after the
 * await never runs on that path, leaving both stacks poppable against a
 * document whose byte state no longer matches either of them. Clearing first
 * costs, at worst, an undo stack dropped by a reload that then failed --
 * strictly the safer end of the trade.
 */
function invalidateOtherUndoStacks(): void {
  usePageOpsStore.getState().clearUndo();
  useTextEditStore.getState().clearUndo();
}

/**
 * How long after the last nudge key before the edit is written to the document.
 *
 * Unlike every other overlay, an embedded image lives in the page's content
 * stream: each change means serialize, mutate with pdf-lib, and reload. Doing
 * that per keystroke would make a held arrow key unusable, so keyboard moves
 * accumulate in previewCssRect (exactly as a drag does) and commit once the user
 * stops, which is also what pointerup does for a drag.
 */
const NUDGE_COMMIT_DELAY_MS = 600;

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
  const vr = convertToViewportRectangle(viewport, [
    rect.x,
    rect.y,
    rect.x + rect.width,
    rect.y + rect.height,
  ]);
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
  // Some OTHER feature is mid-flight rewriting the document; selecting an
  // image stays fine (it touches nothing outside this layer's own store),
  // but every action that would actually commit a change waits for it, the
  // same way it would wait for an image edit of its own. Owner-scoped, so an
  // image edit already in flight here does not make these controls blame
  // another feature for it. See documentMutationStore.ts.
  const crossBusy = useDocumentMutationBlocked('imageedit', 'content');
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
    await withDocumentMutation(
      { owner: 'imageedit', scope: 'content' },
      async () => {
        try {
          const bytes = await getEngine().saveDocument();
          const result = await commitImageEdit({
            pdfBytes: bytes,
            pageIndex: current.pageIndex,
            target: { streamIndex: current.streamIndex, name: current.name, rect: current.rect },
            action: { kind: 'move', rect },
          });
          // Keep the same image selected at its new rect (rather than waiting
          // on the docVersion-triggered re-fetch below) so there is no visible
          // gap once previewCssRect clears in `finally`.
          select({ ...current, rect });
          invalidateOtherUndoStacks();
          await reloadEditedBytes(result);
        } catch (error) {
          const message =
            error instanceof ImageEditError ? error.message : 'Could not move this image';
          pushToast(message, 'error');
        } finally {
          setPreviewCssRect(null);
        }
      },
      () => {
        // startDrag/startResize/onNudge below all check this before a gesture
        // even starts, but something else can still win the race after one is
        // already under way -- and a debounced nudge can land on this layer's
        // OWN previous commit, which is why the message is chosen rather than
        // fixed. Undo the attempt visually rather than leaving it to commit
        // silently once the holder is done.
        pushToast(documentMutationBusyMessage('imageedit', 'content'), 'info');
        setPreviewCssRect(null);
      },
    );
  };

  // The selection's box in CSS pixels: the live preview while a drag or a run of
  // nudge keys is in flight, otherwise the committed rect. Declared here rather
  // than just above the return because the keyboard handling below converts it
  // into page fractions.
  const cssRect =
    viewport && isThisPage && selected
      ? (previewCssRect ?? pdfRectToCssRect(viewport, selected.rect))
      : null;

  /* -------------------------------------------------------------------------
   * Keyboard move and resize
   *
   * Shares src/a11y/useNudgeKeys with the overlay layers, so the bindings are
   * identical everywhere. Two adaptations for this feature: the hook works in
   * page fractions while this layer works in CSS pixels (converted below), and
   * the commit is debounced rather than immediate (see NUDGE_COMMIT_DELAY_MS).
   * ---------------------------------------------------------------------- */

  // Focus moves to the selection chrome whenever a different image is selected,
  // so the keys below apply to what the user just picked. Keyed on the target
  // rather than the object identity, since commitMove replaces `selected` with
  // an equal-but-new object after every move and refocusing on that would fight
  // a screen reader mid-run.
  const selectionRef = useRef<HTMLDivElement>(null);
  const selectionKey = isThisPage && selected ? `${selected.streamIndex}:${selected.name}` : null;
  useEffect(() => {
    if (selectionKey) selectionRef.current?.focus();
  }, [selectionKey]);

  const nudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingNudge = () => {
    if (nudgeTimer.current) clearTimeout(nudgeTimer.current);
    nudgeTimer.current = null;
  };
  useEffect(() => cancelPendingNudge, []);

  const pageBox = () =>
    document
      .querySelector(`.folio-page[data-page-number="${pageNumber}"]`)
      ?.getBoundingClientRect() ?? null;

  // The selection as page fractions, which is what the shared hook speaks.
  const nudgeRect = ((): NudgeRect | null => {
    const page = pageBox();
    if (!page || !page.width || !page.height || !cssRect) return null;
    return {
      x: cssRect.x / page.width,
      y: cssRect.y / page.height,
      width: cssRect.width / page.width,
      height: cssRect.height / page.height,
    };
  })();

  // Returning false rather than just bailing: useNudgeKeys announces what the
  // keypress did, and without an answer from here it would tell a screen
  // reader the image moved when nothing moved at all. See NudgeKeysOptions.
  const onNudge = (next: NudgeRect): boolean => {
    const page = pageBox();
    if (!page || !viewport || !selected) return false;
    // crossBusy: see startDrag's identical guard above -- commitMove would
    // refuse this once the debounce below fires anyway, so refuse the
    // keypress's own preview move too rather than letting it settle back.
    if (crossBusy) return false;
    const nextCss = {
      x: next.x * page.width,
      y: next.y * page.height,
      width: next.width * page.width,
      height: next.height * page.height,
    };
    // Local preview now, document write once the run of keys settles.
    setPreviewCssRect(nextCss);
    cancelPendingNudge();
    nudgeTimer.current = setTimeout(() => {
      nudgeTimer.current = null;
      void commitMove(cssRectToPdfRect(viewport, nextCss), selected);
    }, NUDGE_COMMIT_DELAY_MS);
    return true;
  };

  const onKeyDown = useNudgeKeys({
    rect: nudgeRect ?? { x: 0, y: 0, width: 0, height: 0 },
    label: 'Image',
    // Aspect-locked to the image's own pixel dimensions, matching startResize.
    aspectLocked: true,
    minWidth: 0.02,
    onChange: onNudge,
    // Same reason onNudge reports a refusal: handleDelete's own guard is
    // synchronous but lives past an await, so the answer has to be given here
    // or "Image deleted" is announced over an image that is still there.
    // wouldBlock rather than crossBusy, because a delete arriving on top of
    // this layer's own in-flight commit is refused just as firmly, and the
    // announcement would be just as wrong.
    onDelete: () => {
      if (documentMutationWouldBlock('content')) return false;
      void handleDelete();
      return true;
    },
  });

  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    // selectedInfo?.editable: selecting a non-editable image (see tryClickAt
    // above) now reaches here too, and without this the drag would run to
    // completion visually, then revert with a toast on pointerup once
    // commitMove's own editable check fails it -- a more confusing dead end
    // than simply not starting the drag. crossBusy is the same idea for
    // another feature's mid-flight mutation: commitMove already refuses it,
    // so refuse the drag itself rather than letting it run to a revert too.
    if (e.button !== 0 || !viewport || !selected || !selectedInfo?.transformable || crossBusy)
      return;
    if (!selectedInfo.editable) return;
    const pageRect = pageRectFrom(e.currentTarget);
    if (!pageRect) return;
    e.preventDefault();
    // A drag supersedes a keyboard nudge that has not been written yet, so the
    // debounced commit does not land on top of the gesture in progress.
    cancelPendingNudge();
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
    // selectedInfo.editable, crossBusy: see startDrag's identical guard above.
    if (e.button !== 0 || !viewport || !selected || !selectedInfo?.transformable || crossBusy)
      return;
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
    // Before taking the lock, not after: picking a file is a human-scale wait,
    // so anything else that was mid-flight when this was clicked has almost
    // certainly finished by the time the picker resolves -- and holding the
    // lock across a native dialog would freeze every other feature for as long
    // as the user browsed.
    const picked = await pickImageFile();
    if (!picked) return;

    await withDocumentMutation(
      { owner: 'imageedit', scope: 'content' },
      async () => {
        try {
          const bytes = await getEngine().saveDocument();
          const result = await commitImageEdit({
            pdfBytes: bytes,
            pageIndex: selected.pageIndex,
            target: { streamIndex: selected.streamIndex, name: selected.name, rect: selected.rect },
            action: { kind: 'replace', dataUrl: picked.dataUrl, mime: picked.mime },
          });
          invalidateOtherUndoStacks();
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
      },
      () => pushToast(documentMutationBusyMessage('imageedit', 'content'), 'info'),
    );
  };

  const handleDelete = async () => {
    if (!selected) return;
    await withDocumentMutation(
      { owner: 'imageedit', scope: 'content' },
      async () => {
        try {
          const bytes = await getEngine().saveDocument();
          const result = await commitImageEdit({
            pdfBytes: bytes,
            pageIndex: selected.pageIndex,
            target: { streamIndex: selected.streamIndex, name: selected.name, rect: selected.rect },
            action: { kind: 'delete' },
          });
          select(null);
          invalidateOtherUndoStacks();
          await reloadEditedBytes(result);
        } catch (error) {
          const message =
            error instanceof ImageEditError ? error.message : 'Could not delete this image';
          pushToast(message, 'error');
        }
      },
      () => pushToast(documentMutationBusyMessage('imageedit', 'content'), 'info'),
    );
  };

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
          // Focused on selection (see the effect below) so the nudge keys work
          // straight after the click or Enter that selected the image, without a
          // second Tab to find it. Only one image is ever selected, so this adds
          // a single tab stop rather than one per image on the page.
          ref={selectionRef}
          tabIndex={0}
          role="group"
          aria-label={
            selectedInfo?.transformable && selectedInfo?.editable
              ? 'Selected image. Arrow keys move it, plus and minus resize it, Delete removes it.'
              : 'Selected image. Delete removes it; this one cannot be moved or resized.'
          }
          onKeyDown={onKeyDown}
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
              disabled={crossBusy}
              title={crossBusy ? DOCUMENT_MUTATION_BUSY_TITLE : undefined}
              onClick={() => void handleReplace()}
            >
              Replace image…
            </button>
          </div>
          <button
            type="button"
            className="folio-edit__delete"
            aria-label="Delete image"
            title={crossBusy ? DOCUMENT_MUTATION_BUSY_TITLE : 'Delete image'}
            disabled={crossBusy}
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
