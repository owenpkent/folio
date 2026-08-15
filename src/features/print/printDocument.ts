// The legacy bundle, for the reason setupWorker.ts spells out, and because
// `ensureWorker()` sets `workerSrc` on *that* module's globals: importing the
// default build here gave print a second, unconfigured copy of PDF.js, and
// every print failed on `No "GlobalWorkerOptions.workerSrc" specified`. Types
// still come from the package root, as PdfJsEngine does it.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, RenderTask } from 'pdfjs-dist';
import { flushSync } from 'react-dom';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { mapWithConcurrency } from '@/core/concurrency';
import { ensureWorker, pdfWasmUrl } from '@/core/pdf/setupWorker';
import { exportDocument } from '@/features/export';
import { confirmIncompleteOcr } from '@/features/ocr';
import {
  documentMutationBlocked,
  DOCUMENT_MUTATION_BUSY_TITLE,
  withDocumentMutation,
} from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';

import { usePrintStore } from './store';

/**
 * Rasterization scale for print when the document is short enough to afford it.
 * 2x the PDF's 72dpi user space is 144dpi, which is past the point where a
 * laser printer's halftoning hides the difference and well short of the memory
 * a 300dpi page bitmap would cost. Longer documents get less; see chooseScale.
 */
const PRINT_SCALE = 2;

/**
 * The floor chooseScale is allowed to drop to. 0.75x is 54dpi: visibly soft on
 * a photograph, still readable as body text, and the point below which shrinking
 * further buys less memory than it costs legibility. A document that cannot fit
 * the budget even here is refused rather than printed illegibly.
 */
const MIN_PRINT_SCALE = 0.75;

/**
 * Peak bitmap budget for one print run, in bytes.
 *
 * Every page has to be in the DOM and decoded at the moment window.print()
 * paints the preview: the print engine takes the whole document at once, so
 * there is no batch that can be released "as it is consumed". Residency, not
 * decode concurrency, is therefore the number that decides whether the renderer
 * survives, and the only levers left are how big each bitmap is and how many of
 * them there are.
 *
 * A decoded page costs width x height x 4 bytes of RGBA. A Letter page at
 * scale 1 is 612 x 792 x 4 = 1.85 MiB, so this budget buys about 104 Letter
 * pages at the full 2x, 415 at 1x, and 738 at MIN_PRINT_SCALE. 768 MiB leaves
 * room for the exported bytes, the throwaway PDF.js document and the rest of
 * the app inside a renderer that in practice falls over well short of 2 GiB.
 */
const PRINT_BITMAP_BUDGET_BYTES = 768 * 1024 * 1024;

/**
 * Ceilings on a single page bitmap. Past a platform limit a browser quietly
 * refuses to back the canvas: getContext('2d') returns null, or the surface
 * comes back blank, with no error either way. An A0 sheet is 2384 x 3370 user
 * units, which at 2x is 4768 x 6740 = 32.1M pixels, so it has to be scaled down
 * deliberately instead of silently yielding an empty sheet.
 *
 * TODO: de-duplicate against PdfJsEngine's MAX_CANVAS_AREA / MAX_CANVAS_DIM
 * when #68 merges. Two copies of these numbers must not be allowed to drift.
 */
const MAX_CANVAS_AREA = 16_777_216; // 4096 x 4096
const MAX_CANVAS_DIM = 4096;

const PRINT_ROOT_ID = 'folio-print-root';

/**
 * Set on <body> only while a print run is staged. The print stylesheet hides
 * the whole UI, and it has to key off something that is present for exactly as
 * long as the print root is: keying off the root's own existence blanked every
 * print that did not come from here, because that root exists for a few
 * milliseconds per run and never otherwise.
 */
const PRINT_BODY_CLASS = 'folio-printing';

/**
 * How many page images to decode at once. Each decoded page is several MiB, and
 * asking for all of them in one Promise.all allocates every bitmap in the same
 * tick. Four keeps the decoders busy on any machine. Note this bounds the rate,
 * not the total: what bounds the total is the scale chosen by chooseScale.
 */
const DECODE_CONCURRENCY = 4;

/**
 * How long to keep the print DOM alive when `afterprint` never arrives. Long
 * enough for a slow preview to finish rasterizing, short enough that several
 * hundred megabytes of bitmap is not stranded for the rest of the session.
 */
const PRINT_TEARDOWN_TIMEOUT_MS = 60_000;

/** Bytes a decoded RGBA bitmap of this page costs at `scale`. */
function bitmapBytes(width: number, height: number, scale: number): number {
  return Math.floor(width * scale) * Math.floor(height * scale) * 4;
}

/**
 * The largest scale at or below PRINT_SCALE whose whole-document bitmap cost
 * fits PRINT_BITMAP_BUDGET_BYTES, or null when even MIN_PRINT_SCALE does not.
 *
 * Cost grows with the square of the scale, so the affordable scale is
 * sqrt(budget / (pages x bytes-per-page-at-1x)).
 */
export function chooseScale(width: number, height: number, pageCount: number): number | null {
  const perPage = bitmapBytes(width, height, 1);
  if (perPage <= 0 || pageCount <= 0) return PRINT_SCALE;
  const affordable = Math.sqrt(PRINT_BITMAP_BUDGET_BYTES / (perPage * pageCount));
  if (affordable < MIN_PRINT_SCALE) return null;
  return Math.min(PRINT_SCALE, affordable);
}

/** `scale` reduced until this page fits both canvas ceilings. */
export function capScale(width: number, height: number, scale: number): number {
  if (width <= 0 || height <= 0) return scale;
  const byDimension = Math.min(MAX_CANVAS_DIM / width, MAX_CANVAS_DIM / height);
  const byArea = Math.sqrt(MAX_CANVAS_AREA / (width * height));
  return Math.min(scale, byDimension, byArea);
}

/**
 * Tear down once the print job has let go of the images.
 *
 * window.print() blocks until the dialog closes on Chromium, but not on every
 * engine: WebKit can return while the preview is still being generated. Undoing
 * the DOM and revoking the blob URLs on the next line therefore races the
 * preview and prints blank sheets. Wait for `afterprint` instead, with a timer
 * for the engines that never fire it, and let whichever arrives first win.
 */
function teardownAfterPrint(cleanup: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    window.removeEventListener('afterprint', once);
    clearTimeout(timer);
    cleanup();
  };
  // `once` only ever runs from one of the two lines below, so `timer` is
  // always initialized by the time it reads it.
  const timer = setTimeout(once, PRINT_TEARDOWN_TIMEOUT_MS);
  window.addEventListener('afterprint', once);
}

/**
 * True from the moment a run starts until it has handed over to the print
 * dialog. Two overlapping runs reach appendChild before either calls print(),
 * so the preview contains the document twice, and the first run's finish()
 * hides the modal while the second is still rasterizing.
 *
 * Held Ctrl+P is no longer how that happens: the shortcut dispatcher swallows
 * OS key repeat (see REPEATABLE_KEYS in useKeyboardShortcuts). This
 * guards every other way in, which is most of them: the File menu, the command
 * registry, and any plugin calling printDocument directly.
 */
let inFlight = false;

/**
 * Print the open document, including every unsaved edit.
 *
 * Edits, signatures, check marks, and highlights live as DOM overlays above the
 * page canvas, not as pixels in it, so printing the on-screen canvas would drop
 * all of them silently. Instead this bakes through the ordinary save pipeline
 * ({@link exportDocument}), then rasterizes those baked bytes in a throwaway
 * PDF.js document. What comes out of the printer is exactly what a saved copy
 * would contain.
 *
 * The pages are rasterized without the dark-mode invert/tint: dark mode is a
 * screen reading aid, and nobody wants a black page on paper.
 */
export async function printDocument(): Promise<void> {
  if (useDocumentStore.getState().status !== 'ready') return;
  if (inFlight) return;
  inFlight = true;

  // Before any of the run's own state is set up, and before the mutation lock:
  // a recognition pass still filling in the OCR sidecar would otherwise be
  // baked half-done into the printout with nothing said about it. `inFlight`
  // is already true, so a second Ctrl+P cannot stack a second question behind
  // this one; it has to be cleared by hand on this path because the try/finally
  // that normally does it has not been entered yet.
  if (!(await confirmIncompleteOcr('print'))) {
    inFlight = false;
    return;
  }

  const objectUrls: string[] = [];
  let root: HTMLDivElement | null = null;
  let renderTask: RenderTask | null = null;
  let handedToDialog = false;
  // PDF.js 6 removed PDFDocumentProxy.destroy(); tearing down the loading task
  // is what releases the worker now. Held out here, rather than beside the
  // document it resolves to, so a load that never resolves is still torn down.
  let loadingTask: PDFDocumentLoadingTask | null = null;

  /** Release the throwaway document. Safe to call twice; the second is a no-op. */
  const destroyDoc = async () => {
    const task = loadingTask;
    // Null first: destroy() awaits a worker round-trip, and the normal path and
    // the outer finally must not both destroy the same task.
    loadingTask = null;
    if (task) await task.destroy();
  };

  const cleanup = () => {
    if (root?.parentNode) root.parentNode.removeChild(root);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.length = 0;
    root = null;
    document.body.classList.remove(PRINT_BODY_CLASS);
  };

  const cancelled = () => usePrintStore.getState().cancelRequested;

  /** Take the cancel exit if one has been asked for. Safe to call repeatedly. */
  const stopIfCancelled = (): boolean => {
    if (!cancelled()) return false;
    cleanup();
    usePrintStore.getState().finish();
    return true;
  };

  // requestCancel only sets a flag, and the flag can only be read between
  // pages. That is no help while a single large page is mid-render, so cancel
  // the pdf.js task too: it is the only thing that stops the page in progress.
  const unsubscribe = usePrintStore.subscribe((s) => {
    if (s.cancelRequested) renderTask?.cancel();
  });

  usePrintStore.getState().start(0);

  try {
    // Under the cross-feature lock, and only this line: print bakes through
    // the very same snapshot Save does -- the engine's bytes plus the edit,
    // signature, OCR, and annotation stores -- so a page op mid-swap or a
    // recognition run mid-remap would put OCR text and stamped edits on the
    // wrong pages of the printout. Everything below works from `bytes`, a
    // private copy nothing else can disturb, so the lock is released before
    // the rasterizing and long before window.print(). See
    // documentMutationStore.ts and saveDocument.ts's exportUnderLock.
    const bytes = await withDocumentMutation<Uint8Array | null>(
      { owner: 'export', scope: 'content' },
      exportDocument,
      () => null,
    );
    if (!bytes) throw new Error(DOCUMENT_MUTATION_BUSY_TITLE);

    ensureWorker();
    // wasmUrl for the same reason PdfJsEngine passes it: without it the worker
    // cannot decode JBIG2 or JPEG2000, which is most scanned documents. Print
    // rasterizes in a throwaway document of its own, so it has to ask for the
    // decoders separately -- and a scan that printed blank is exactly the
    // silently-wrong output this whole path exists to avoid.
    loadingTask = pdfjsLib.getDocument({ data: bytes, wasmUrl: pdfWasmUrl() });
    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;
    usePrintStore.getState().setTotal(pageCount);

    const printRoot = document.createElement('div');
    root = printRoot;
    printRoot.id = PRINT_ROOT_ID;
    // Hidden from assistive tech and from the on-screen layout; the print
    // stylesheet is the only thing that ever reveals it.
    printRoot.setAttribute('aria-hidden', 'true');

    const images: HTMLImageElement[] = [];

    try {
      if (pageCount < 1) throw new Error('This document has no pages to print');

      // Page 1 stands in for the whole document when sizing the run. Pages in a
      // real PDF are near enough always the same size, and reading every
      // viewport up front would mean loading every page before rasterizing any.
      const firstPage = await doc.getPage(1);
      const unitViewport = firstPage.getViewport({ scale: 1 });
      const scale = chooseScale(unitViewport.width, unitViewport.height, pageCount);
      if (scale === null) {
        throw new Error(
          `This document is too long to print in one pass (${pageCount} pages). ` +
            'Save it first, then print in smaller ranges.',
        );
      }

      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        if (stopIfCancelled()) return;
        usePrintStore.getState().setProgress(pageNumber);

        const page = pageNumber === 1 ? firstPage : await doc.getPage(pageNumber);
        const unit = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: capScale(unit.width, unit.height, scale) });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // Not used for drawing -- PDF.js v6 takes the canvas and calls
        // getContext itself. Asked for anyway because a null return is how
        // Chromium reports exhausted canvas memory, and finding that out here
        // gives a real error instead of a render that fails somewhere inside
        // the worker.
        if (!canvas.getContext('2d')) throw new Error('Could not acquire a 2D canvas context');

        renderTask = page.render({ canvas, viewport });
        try {
          await renderTask.promise;
        } finally {
          renderTask = null;
        }

        // A blob URL rather than a data URL: base64 inflates by a third, and a
        // long document holds every page in memory at once.
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );

        // Free the bitmap now rather than at the next GC; even a capped page
        // canvas is several megabytes.
        canvas.width = 0;
        canvas.height = 0;

        if (!blob) throw new Error(`Could not rasterize page ${pageNumber}`);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);

        const holder = document.createElement('div');
        holder.className = 'folio-print-page';
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        holder.appendChild(img);
        printRoot.appendChild(holder);
        images.push(img);
      }
    } finally {
      // Before the dialog, not after: the rasters are already in blob URLs, so
      // holding the worker and its decoded pages through print() would double
      // the peak for a long document and buy nothing.
      await destroyDoc();
    }

    // Cancelling on the last page used to still open the dialog with the whole
    // document queued: the flag was read inside the loop and nowhere else.
    if (stopIfCancelled()) return;

    document.body.classList.add(PRINT_BODY_CLASS);
    document.body.appendChild(printRoot);

    // The dialog screenshots the page synchronously, so every image has to have
    // finished decoding before print() or the preview comes out blank.
    const missing = await mapWithConcurrency<HTMLImageElement, number>(
      images,
      DECODE_CONCURRENCY,
      async (img) => {
        // WebKit rejects decode() for reasons that have nothing to do with the
        // image being usable, so the rejection is not the signal to act on.
        // naturalWidth is: it is non-zero once the bytes have been parsed,
        // whatever decode() said about them.
        await img.decode().catch(() => undefined);
        return img.naturalWidth > 0 && img.naturalHeight > 0 ? 0 : 1;
      },
    );

    // Silently printing the pages that did happen to load leaves the user
    // holding a document with blank sheets in it and no reason given.
    const failedPages = missing.reduce((total, failed) => total + failed, 0);
    if (failedPages > 0) {
      throw new Error(
        `${failedPages} of ${images.length} pages could not be prepared, so nothing was sent to the printer`,
      );
    }

    if (stopIfCancelled()) return;

    // finish() on its own leaves the modal on screen: React commits when its
    // scheduler gets round to it and window.print() is synchronous, so the
    // dialog would capture a page that still has the progress modal and its
    // focus trap on it. flushSync forces the commit before we hand over.
    flushSync(() => usePrintStore.getState().finish());
    announce(`Printing ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`);

    handedToDialog = true;
    try {
      window.print();
    } finally {
      teardownAfterPrint(cleanup);
    }
  } catch (error) {
    // A cancel arrives here as a pdf.js RenderingCancelledException. That is a
    // user action, not a failure, and must not raise an error toast.
    if (cancelled()) {
      cleanup();
      usePrintStore.getState().finish();
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    usePrintStore.getState().fail(message);
    // The message, not just the fact of the failure: the modal is already gone
    // by the time this runs (it only renders while status is 'preparing'), so
    // the toast is the one surface the reason can reach. Several of the reasons
    // thrown above are actionable -- a document too long for one pass says to
    // save it and print in ranges -- and a bare "could not print" strands them.
    pushToast(`Could not print: ${message}`, 'error');
  } finally {
    unsubscribe();
    renderTask = null;
    // A no-op on every path that got as far as rasterizing. It matters when the
    // load itself threw, where there is a live worker and no document to reach
    // it through.
    await destroyDoc();
    inFlight = false;
    // The success path hands cleanup to teardownAfterPrint; running it here
    // too would revoke the blob URLs out from under the preview.
    if (!handedToDialog) cleanup();
  }
}

let registered = false;

export function registerPrintCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'file.print',
    title: 'Print',
    category: 'File',
    keybinding: 'Mod+P',
    // The lock as well as the document: print reads the same snapshot Save
    // does, so it is unavailable for the same reasons and says so the same way.
    when: () =>
      useDocumentStore.getState().status === 'ready' &&
      !documentMutationBlocked('export', 'content'),
    run: () => printDocument(),
  });
}
