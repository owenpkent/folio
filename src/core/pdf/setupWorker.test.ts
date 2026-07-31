import { describe, expect, it, vi } from 'vitest';

// The real module pulls in the whole legacy PDF.js bundle just to reach
// GlobalWorkerOptions; the WASM helpers below are plain URL arithmetic, so stub
// the two imports that exist only for ensureWorker().
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ GlobalWorkerOptions: { workerSrc: '' } }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.mjs' }));

import { PDFJS_WASM_PATH, pdfWasmUrl, setPdfWasmUrl } from './setupWorker';

// The override is process-wide and one-way (an embedder sets it once at boot),
// so the default-behaviour cases have to come before the override case.
describe('pdfWasmUrl', () => {
  it('resolves against the page by default', () => {
    expect(pdfWasmUrl()).toBe(new URL(PDFJS_WASM_PATH, document.baseURI).href);
  });

  it('names a directory, since PDF.js appends filenames to it', () => {
    expect(pdfWasmUrl().endsWith('/')).toBe(true);
  });

  it('takes an embedder override and keeps it a directory', () => {
    // An embedder is as likely to hand over the directory without the trailing
    // slash as with it, and `${base}jbig2.wasm` silently 404s if it is missing.
    setPdfWasmUrl('vscode-webview://host/out/pdfjs-wasm');
    expect(pdfWasmUrl()).toBe('vscode-webview://host/out/pdfjs-wasm/');

    setPdfWasmUrl('vscode-webview://host/out/pdfjs-wasm/');
    expect(pdfWasmUrl()).toBe('vscode-webview://host/out/pdfjs-wasm/');
  });
});
