import * as pdfjsLib from 'pdfjs-dist';
// Vite resolves this to a hashed URL and copies the worker into the bundle.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let configured = false;

/**
 * Point PDF.js at its worker bundle. PDF.js parses and rasterises off the main
 * thread, so this must run once before any document is opened. Idempotent.
 */
export function ensureWorker(): void {
  if (configured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  configured = true;
}
