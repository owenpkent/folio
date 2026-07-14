import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { getEngine } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { recognizeImage } from './recognize';
import { useOcrStore } from './store';

const ready = () => useDocumentStore.getState().status === 'ready';

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

/** OCR the whole document, page by page, with progress and cancellation. */
export async function recognizeDocument(): Promise<void> {
  if (!ready() || useOcrStore.getState().status === 'running') return;
  const total = useViewerStore.getState().numPages;
  const store = useOcrStore.getState();
  store.start(total);
  try {
    for (let page = 1; page <= total; page++) {
      if (useOcrStore.getState().cancelRequested) break;
      await recognizeOnePage(page);
    }
    useOcrStore.getState().finish();
    const cancelled = useOcrStore.getState().cancelRequested;
    pushToast(cancelled ? 'OCR stopped' : 'Text recognized', cancelled ? 'info' : 'success');
    announce(cancelled ? 'OCR stopped' : 'Text recognition complete');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OCR failed';
    useOcrStore.getState().fail(message);
    pushToast(`OCR failed: ${message}`, 'error');
  }
}

/** OCR just the page the user is viewing. */
export async function recognizeCurrentPage(): Promise<void> {
  if (!ready() || useOcrStore.getState().status === 'running') return;
  const page = useViewerStore.getState().currentPage;
  const store = useOcrStore.getState();
  store.start(1);
  try {
    await recognizeOnePage(page);
    useOcrStore.getState().finish();
    pushToast('Text recognized', 'success');
    announce(`Text recognized on page ${page}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OCR failed';
    useOcrStore.getState().fail(message);
    pushToast(`OCR failed: ${message}`, 'error');
  }
}

let registered = false;

/** Register the OCR commands. Idempotent. */
export function registerOcrCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'ocr.recognizeDocument',
    title: 'Recognize text (OCR)',
    category: 'Edit',
    when: ready,
    run: () => recognizeDocument(),
  });

  commandRegistry.register({
    id: 'ocr.recognizePage',
    title: 'Recognize text on this page (OCR)',
    category: 'Edit',
    when: ready,
    run: () => recognizeCurrentPage(),
  });
}
