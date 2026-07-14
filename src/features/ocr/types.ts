/**
 * OCR results for a document, produced by tesseract.js and kept as a sidecar
 * (per PDF fingerprint). On screen they render as a selectable text overlay;
 * on save they are baked into the PDF as an invisible searchable text layer.
 */

/** A rectangle as fractions (0..1) of the page, top-left origin. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One recognized word and where it sits on the page. */
export interface OcrWord {
  text: string;
  rect: NormalizedRect;
}

/** Recognition result for a single page. */
export interface OcrPage {
  /** 1-based page number. */
  pageNumber: number;
  words: OcrWord[];
  /** Full page text, used for in-app search fallback. */
  text: string;
}

export type OcrStatus = 'idle' | 'running' | 'done' | 'error';
