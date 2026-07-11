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

export type { PdfEngine } from './PdfEngine';
export * from './types';
