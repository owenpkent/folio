// PDF.js is pulled from `legacy/build`, not the default `build`. The default v6
// bundle assumes a 2025-era engine: it reads `Iterator.prototype` at module
// scope (a ReferenceError, not a feature test, on engines without iterator
// helpers) and calls `Map.prototype.getOrInsertComputed` on the annotation-layer
// render path. Folio's Linux target is webkit2gtk-4.1, whose WebKitGTK on the
// Ubuntu LTS releases CI builds against predates both. The legacy bundle ships
// the core-js polyfills for them, at roughly +58 KB minified on the main bundle
// and +50 KB on the worker. Both imports below must stay on the same build: the
// worker refuses to talk to an API of a different version.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// Vite resolves this to a hashed URL and copies the worker into the bundle.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

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

/**
 * Where PDF.js looks for its WebAssembly decoders, relative to the page.
 *
 * v6 moved JBIG2, JPEG2000 and the ICC colour transform out of JavaScript and
 * into .wasm fetched at run time. The worker builds each URL by appending a
 * filename to this base, so it has to name a directory and end in a slash. That
 * rules out Vite's `?url` handling (how the worker above travels with the
 * bundle): the files must keep their own names and sit next to each other, so
 * vite.config.ts copies the whole directory here instead. Without it a scanned
 * page decodes to nothing -- the pure-JS fallback is loaded from this same base,
 * so it goes missing too.
 */
export const PDFJS_WASM_PATH = 'pdfjs-wasm/';

let wasmUrlOverride: string | null = null;

/**
 * Point PDF.js at a different WASM directory. Embedders that do not serve Folio
 * from the bundle root -- the VS Code webview, whose assets live behind a
 * `vscode-webview://` URI -- call this before opening a document.
 */
export function setPdfWasmUrl(url: string): void {
  wasmUrlOverride = url.endsWith('/') ? url : `${url}/`;
}

/** The resolved WASM directory, absolute so the worker can fetch from it. */
export function pdfWasmUrl(): string {
  return wasmUrlOverride ?? new URL(PDFJS_WASM_PATH, document.baseURI).href;
}
