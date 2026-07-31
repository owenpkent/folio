import * as pdfjsLib from 'pdfjs-dist';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { mapWithConcurrency } from '@/core/concurrency';
import { ensureWorker } from '@/core/pdf/setupWorker';
import { exportDocument } from '@/features/export';
import { useDocumentStore } from '@/state/documentStore';

import { usePrintStore } from './store';

/**
 * Rasterization scale for print. 2x the PDF's 72dpi user space is 144dpi, which
 * is past the point where a laser printer's halftoning hides the difference and
 * well short of the memory a 300dpi page bitmap would cost on a long document.
 */
const PRINT_SCALE = 2;

const PRINT_ROOT_ID = 'folio-print-root';

/**
 * How many page images to decode at once before handing over to the print
 * dialog. Each decoded Letter page at PRINT_SCALE is ~7.4 MiB of RGBA, so
 * decoding the whole array in one `Promise.all` asks the browser for
 * pages x 7.4 MiB simultaneously; a 500-page document alone is ~3.6 GiB. Four
 * keeps the decoders busy on any machine while bounding the peak.
 */
const DECODE_CONCURRENCY = 4;

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

  const store = usePrintStore.getState();
  store.start(0);

  const objectUrls: string[] = [];
  let root: HTMLDivElement | null = null;

  const cleanup = () => {
    if (root?.parentNode) root.parentNode.removeChild(root);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.length = 0;
    root = null;
  };

  try {
    const bytes = await exportDocument();

    ensureWorker();
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    usePrintStore.getState().setTotal(doc.numPages);

    root = document.createElement('div');
    root.id = PRINT_ROOT_ID;
    // Hidden from assistive tech and from the on-screen layout; the print
    // stylesheet is the only thing that ever reveals it.
    root.setAttribute('aria-hidden', 'true');

    const images: HTMLImageElement[] = [];

    try {
      for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
        if (usePrintStore.getState().cancelRequested) {
          cleanup();
          usePrintStore.getState().finish();
          return;
        }
        usePrintStore.getState().setProgress(pageNumber);

        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: PRINT_SCALE });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Could not acquire a 2D canvas context');

        await page.render({ canvasContext: context, viewport }).promise;

        // A blob URL rather than a data URL: base64 inflates by a third, and a
        // long document holds every page in memory at once.
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/png'),
        );
        if (!blob) throw new Error(`Could not rasterize page ${pageNumber}`);
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);

        const holder = document.createElement('div');
        holder.className = 'folio-print-page';
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        holder.appendChild(img);
        root.appendChild(holder);
        images.push(img);

        // Free the bitmap now rather than at the next GC; at 144dpi each page
        // canvas is several megabytes.
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      await doc.destroy();
    }

    document.body.appendChild(root);
    // The dialog screenshots the page synchronously, so every image has to have
    // finished decoding before print() or the preview comes out blank. That
    // barrier stays; only its width changes. Decoding a few at a time removes
    // the gratuitous part of the cost -- Promise.all asked the browser to
    // allocate every page's bitmap in the same tick -- but note it does not
    // bound the peak on its own: whether the earlier bitmaps are still resident
    // by the time the last one decodes is the browser's call, and printing does
    // need them all painted in the end. Rasterizing a long document is
    // expensive by design; this just stops it being needlessly so.
    await mapWithConcurrency(images, DECODE_CONCURRENCY, (img) =>
      img.decode().catch(() => undefined),
    );

    // Drop the modal before handing over to the system dialog.
    usePrintStore.getState().finish();
    announce(`Printing ${doc.numPages} ${doc.numPages === 1 ? 'page' : 'pages'}`);

    window.print();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    usePrintStore.getState().fail(message);
    pushToast('Could not prepare the document for printing', 'error');
  } finally {
    cleanup();
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
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => printDocument(),
  });
}
