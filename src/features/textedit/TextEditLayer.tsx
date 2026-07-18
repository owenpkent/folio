import { useEffect, useRef, type MouseEvent } from 'react';

import { pushToast } from '@/components/common';
import { getEngine, type PageTextItems } from '@/core/pdf';
import { reloadEditedBytes } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { matchRunToItem } from './contentStream';
import { getLocatedRuns } from './locateCache';
import { commitTextEdit, TexteditError } from './mutate';
import { useTextEditStore, type EditingSession } from './store';
import type { RunColor } from './types';

/** A PDF.js text-content item that carries a string (excludes marked-content markers). */
type PdfTextItem = Extract<PageTextItems['items'][number], { str: string }>;

const hasStr = (item: PageTextItems['items'][number]): item is PdfTextItem => 'str' in item;

/**
 * A couple of PDF user-space units of slack around each item's box, so a click
 * does not have to land pixel-perfectly on a glyph.
 */
const HIT_PAD = 2;

/**
 * The item's box in PDF user space: [x0, y0, x1, y1]. The 0.2*height allowance
 * below the baseline covers descenders without inflating the box so much that
 * adjacent lines start to overlap.
 */
function itemBox(item: PdfTextItem): [number, number, number, number] {
  const transform = item.transform as number[];
  const tx = transform[4];
  const ty = transform[5];
  return [tx, ty - 0.2 * item.height, tx + item.width, ty + item.height];
}

/** The smallest item box containing (x, y): the PDF.js-item side of the hit test. */
function findBestItem(items: PageTextItems['items'], x: number, y: number): PdfTextItem | null {
  let best: PdfTextItem | null = null;
  let bestArea = Infinity;
  for (const raw of items) {
    if (!hasStr(raw) || raw.str.length === 0) continue;
    const [x0, y0, x1, y1] = itemBox(raw);
    if (x < x0 - HIT_PAD || x > x1 + HIT_PAD || y < y0 - HIT_PAD || y > y1 + HIT_PAD) continue;
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      best = raw;
      bestArea = area;
    }
  }
  return best;
}

const rgbCss = (c: RunColor) =>
  `rgb(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)})`;

/**
 * In-place editing overlay for one page: click existing text to replace it.
 * The clicked PDF.js text item is matched to a located show-text operator in
 * the page's content stream (see ./types.ts for the pipeline this feature
 * implements). Only interactive while the "Edit text" tool (store.active) is on.
 */
export function TextEditLayer({ pageNumber }: { pageNumber: number }) {
  const active = useTextEditStore((s) => s.active);
  const session = useTextEditStore((s) => s.session);
  const scale = useViewerStore((s) => s.scale);
  const rootRef = useRef<HTMLDivElement>(null);
  const pageIndex = pageNumber - 1;

  // Hover affordance lives on the text layer, a sibling of this one; toggle a
  // class on their shared .folio-page ancestor rather than reaching sideways.
  useEffect(() => {
    const pageEl = rootRef.current?.closest<HTMLElement>('.folio-page');
    pageEl?.classList.toggle('is-textedit-active', active);
    return () => {
      pageEl?.classList.remove('is-textedit-active');
    };
  }, [active]);

  const isThisPage = session != null && session.pageIndex === pageIndex;

  const tryEditAt = async (pageEl: HTMLElement, clientX: number, clientY: number) => {
    const pageRect = pageEl.getBoundingClientRect();
    const cssX = clientX - pageRect.left;
    const cssY = clientY - pageRect.top;

    const engine = getEngine();
    const viewport = await engine.getPageViewport(pageNumber, scale);
    const [pdfX, pdfY] = viewport.convertToPdfPoint(cssX, cssY) as [number, number];

    const { items, styles } = await engine.getTextItems(pageNumber);
    const item = findBestItem(items, pdfX, pdfY);
    if (!item) return;

    const docVersion = useDocumentStore.getState().docVersion;
    const runs = await getLocatedRuns(docVersion, pageIndex);
    const transform = item.transform as number[];
    const origin = { x: transform[4], y: transform[5] };
    const run = matchRunToItem(runs, origin, undefined);

    if (!run) {
      pushToast('This text cannot be edited (it may be part of an embedded object)', 'error');
      return;
    }
    if (!run.editable) {
      pushToast(run.blockedReason ?? 'This text cannot be edited', 'error');
      return;
    }

    const [x0, y0, x1, y1] = itemBox(item);
    const vr = viewport.convertToViewportRectangle([x0, y0, x1, y1]) as [
      number,
      number,
      number,
      number,
    ];
    const cssRect = {
      x: Math.min(vr[0], vr[2]),
      y: Math.min(vr[1], vr[3]),
      width: Math.abs(vr[2] - vr[0]),
      height: Math.abs(vr[3] - vr[1]),
    };

    useTextEditStore.getState().beginSession({
      pageIndex,
      // run.x/run.y (not the PDF.js item's own origin): commitTextEdit
      // re-locates the run with the same parser that produced these, so using
      // its own coordinates guarantees the re-match, rather than leaning on
      // matchRunToItem's distance tolerance to bridge two independent origins.
      target: { x: run.x, y: run.y, op: run.op },
      prefillText: item.str,
      cssRect,
      fontFamily: styles[item.fontName]?.fontFamily ?? 'sans-serif',
      fontSizePx: item.height * scale,
      color: run.color,
      fontSize: run.fontSize,
      pdfFontName: item.fontName,
    });
  };

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    const pageEl = e.currentTarget.closest<HTMLElement>('.folio-page');
    if (!pageEl) return;
    const { clientX, clientY } = e;
    void tryEditAt(pageEl, clientX, clientY);
  };

  /**
   * Commit flow: serialize the document fresh (so anything the user changed
   * while the editor was open, e.g. a form-field value, is not silently
   * reverted), replace the run in those bytes, then live-reload the result.
   */
  const handleCommit = (newText: string, onFailure: () => void) => {
    const currentSession = useTextEditStore.getState().session;
    if (!currentSession) {
      onFailure();
      return;
    }

    void (async () => {
      try {
        const bytes = await getEngine().saveDocument();
        const result = await commitTextEdit({
          pdfBytes: bytes,
          pageIndex: currentSession.pageIndex,
          target: currentSession.target,
          newText,
          style: {
            fontFamilyHint: `${currentSession.pdfFontName} ${currentSession.fontFamily}`.trim(),
            fontSize: currentSession.fontSize,
            color: currentSession.color,
          },
        });
        // Only push the pre-edit snapshot once the commit has actually
        // succeeded: a failed attempt below never reaches here, so there is
        // nothing to compensate for in the catch block.
        useTextEditStore.getState().pushUndo(bytes);
        await reloadEditedBytes(result);
        useTextEditStore.getState().endSession();
      } catch (error) {
        const message =
          error instanceof TexteditError ? error.message : 'Could not save this text edit';
        pushToast(message, 'error');
        onFailure();
      }
    })();
  };

  const handleCancel = () => {
    useTextEditStore.getState().endSession();
  };

  return (
    <div ref={rootRef} className="folio-textedit-layer" data-pan-exclude>
      {active && !session && (
        <button
          type="button"
          className="folio-textedit-hit"
          aria-label="Click text on the page to edit it"
          onClick={handleClick}
        />
      )}
      {isThisPage && session && (
        <TextEditorBox session={session} onCommit={handleCommit} onCancel={handleCancel} />
      )}
    </div>
  );
}

interface TextEditorBoxProps {
  session: EditingSession;
  onCommit: (newText: string, onFailure: () => void) => void;
  onCancel: () => void;
}

/** The editable surface for the run currently open, prefilled and caret-at-end. */
function TextEditorBox({ session, onCommit, onCancel }: TextEditorBoxProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Guards against handling the same close twice, e.g. Escape removing this
  // element can itself raise a blur that would otherwise also try to commit.
  const settledRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = session.prefillText;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // This box is only ever mounted for one session; deliberately run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attemptCommit = () => {
    if (settledRef.current) return;
    const text = ref.current?.textContent ?? '';
    if (text === session.prefillText) {
      settledRef.current = true;
      onCancel();
      return;
    }
    settledRef.current = true;
    onCommit(text, () => {
      // Commit failed and the editor stays open: allow another attempt.
      settledRef.current = false;
    });
  };

  const attemptCancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  return (
    <div
      ref={ref}
      className="folio-textedit-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Edit text"
      tabIndex={-1}
      style={{
        left: session.cssRect.x,
        top: session.cssRect.y,
        width: session.cssRect.width,
        height: session.cssRect.height,
        fontFamily: session.fontFamily,
        fontSize: `${session.fontSizePx}px`,
        color: rgbCss(session.color),
      }}
      onBlur={attemptCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          attemptCommit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          attemptCancel();
        }
      }}
    />
  );
}
