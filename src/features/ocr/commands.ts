import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { getEngine } from '@/core/pdf';
import {
  documentMutationBlocked,
  DOCUMENT_MUTATION_BUSY_TITLE,
  withDocumentMutation,
} from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { recognizeImage } from './recognize';
import { useOcrStore } from './store';

/**
 * OCR needs its self-hosted runtime present. The Chrome extension package ships
 * without it, so the commands must be unavailable there rather than failing on a
 * missing asset once the user has already committed to running them.
 */
export const ocrAvailable = (): boolean => __OCR_BUNDLED__;

const ready = () => ocrAvailable() && useDocumentStore.getState().status === 'ready';

// Rasterise at 2x for legible glyphs; a good accuracy/speed trade-off.
const OCR_SCALE = 2;

/** Recognize a single page and store its words. */
async function recognizeOnePage(pageNumber: number): Promise<void> {
  const store = useOcrStore.getState();
  store.setProgress(pageNumber, 0);
  const image = await getEngine().renderPageToImage(pageNumber, OCR_SCALE);
  const { words, text } = await recognizeImage(image.dataUrl, image.width, image.height, (p) =>
    useOcrStore.getState().setProgress(pageNumber, p),
  );
  useOcrStore.getState().setPage({ pageNumber, words, text });
}

/**
 * Report a run that could not start because something else holds the lock.
 *
 * Recognition used to return silently here while its menu row stayed enabled,
 * so clicking "Recognize text (OCR)" during a page op did nothing at all: no
 * toast, no announcement, no progress modal.
 */
function reportBlocked(): void {
  pushToast(DOCUMENT_MUTATION_BUSY_TITLE, 'info');
  announce(DOCUMENT_MUTATION_BUSY_TITLE, true);
}

/**
 * Run one recognition pass under the cross-feature lock.
 *
 * Scope 'sidecar', not 'content': recognition writes into the OCR store page by
 * page and never touches the document's bytes, so what it cannot survive is the
 * page map moving underneath it -- a page op's snapshot/restore/remap of that
 * same store (see pageops/pageState.ts), a combine, an open, or a close. A text
 * edit, an image edit, a save, or a print leaves the page map exactly as it
 * was, and those are free to run alongside a recognition pass that can take
 * minutes on a long document. See documentMutationStore.ts.
 */
async function runRecognition(total: number, pass: () => Promise<void>): Promise<void> {
  if (!ready() || useOcrStore.getState().status === 'running') return;

  return withDocumentMutation(
    { owner: 'ocr', scope: 'sidecar' },
    async () => {
      // Inside the lock: start() puts the progress modal up, and doing that
      // before an acquire that might be refused would leave it on screen over
      // a run that never began.
      useOcrStore.getState().start(total);
      try {
        await pass();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'OCR failed';
        useOcrStore.getState().fail(message);
        pushToast(`OCR failed: ${message}`, 'error');
      }
    },
    reportBlocked,
  );
}

/** OCR the whole document, page by page, with progress and cancellation. */
export async function recognizeDocument(): Promise<void> {
  const total = useViewerStore.getState().numPages;
  await runRecognition(total, async () => {
    for (let page = 1; page <= total; page++) {
      if (useOcrStore.getState().cancelRequested) break;
      await recognizeOnePage(page);
    }
    useOcrStore.getState().finish();
    const cancelled = useOcrStore.getState().cancelRequested;
    pushToast(cancelled ? 'OCR stopped' : 'Text recognized', cancelled ? 'info' : 'success');
    announce(cancelled ? 'OCR stopped' : 'Text recognition complete');
  });
}

/** OCR just the page the user is viewing. */
export async function recognizeCurrentPage(): Promise<void> {
  const page = useViewerStore.getState().currentPage;
  await runRecognition(1, async () => {
    await recognizeOnePage(page);
    useOcrStore.getState().finish();
    pushToast('Text recognized', 'success');
    announce(`Text recognized on page ${page}`);
  });
}

let registered = false;

/** Register the OCR commands. Idempotent. */
export function registerOcrCommands(): void {
  if (registered) return;
  registered = true;

  // Both guards include the lock, so a surface that reads `when` (the menu
  // bar, the command palette) disables the row while a page op, a combine, an
  // open, or a close is in flight instead of leaving it enabled and inert.
  const canRecognize = () =>
    ready() &&
    useOcrStore.getState().status !== 'running' &&
    !documentMutationBlocked('ocr', 'sidecar');

  commandRegistry.register({
    id: 'ocr.recognizeDocument',
    title: 'Recognize text (OCR)',
    category: 'Edit',
    when: canRecognize,
    run: () => recognizeDocument(),
  });

  commandRegistry.register({
    id: 'ocr.recognizePage',
    title: 'Recognize text on this page (OCR)',
    category: 'Edit',
    when: canRecognize,
    run: () => recognizeCurrentPage(),
  });
}
