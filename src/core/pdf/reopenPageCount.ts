import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

import { ensureWorker, pdfWasmUrl } from './setupWorker';

/**
 * Open `bytes` in a throwaway PDF.js document and report its page count,
 * rejecting if PDF.js cannot read it. Detached from the engine's open document,
 * the same way print rasterizes in a document of its own. Legacy build only:
 * the bare `pdfjs-dist` entry would be a second, unconfigured copy.
 */
export async function reopenPageCount(bytes: Uint8Array): Promise<number> {
  ensureWorker();
  // Copy: PDF.js transfers `data` to the worker, which would detach the caller's
  // bytes right before they are written out.
  const task = pdfjsLib.getDocument({ data: bytes.slice(), wasmUrl: pdfWasmUrl(), verbosity: 0 });
  try {
    const doc = await task.promise;
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}
