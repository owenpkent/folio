import type { PdfEngine } from './PdfEngine';
import { PdfJsEngine } from './PdfJsEngine';

let engine: PdfEngine | null = null;

/**
 * The active engine singleton. The app talks to PDFs only through this, never
 * through PDF.js directly, so the backend stays swappable.
 */
export function getEngine(): PdfEngine {
  if (!engine) engine = new PdfJsEngine();
  return engine;
}

export type { PageTextItems, PdfEngine } from './PdfEngine';
export * from './types';
export { convertToViewportRectangle } from './viewportRect';
export type { Rect4 } from './viewportRect';
export { setPdfWasmUrl } from './setupWorker';
export { HIT_PAD, isTextItem, itemBox, pickTextItem, type TextItemLike } from './textHit';
// Re-exported so callers of getPageViewport can name its return type without
// importing pdfjs-dist themselves, which would breach the rule that PDF.js
// stays behind this barrel (see docs/architecture.md).
export type { PageViewport } from 'pdfjs-dist';
