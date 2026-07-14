/**
 * Engine-agnostic PDF types.
 *
 * Nothing in this file imports PDF.js. The rest of the app depends only on
 * these shapes and on {@link PdfEngine}, so the underlying renderer (PDF.js
 * today, potentially PDFium later) can be swapped without touching the UI.
 */

/** Where a document's bytes come from. */
export type DocumentSource =
  { kind: 'bytes'; data: Uint8Array; name?: string } | { kind: 'url'; url: string; name?: string };

/** Summary returned right after a document loads. */
export interface PdfDocumentInfo {
  numPages: number;
  fingerprint: string;
  name: string;
}

/** Document-level metadata (from the PDF info dictionary / XMP). */
export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  pageCount: number;
}

/** A single entry in the document outline (bookmarks / table of contents). */
export interface OutlineNode {
  title: string;
  /** 1-based page number the entry points to, or null if it cannot resolve. */
  pageNumber: number | null;
  children: OutlineNode[];
}

/** Rendered size of a page, in CSS pixels, at a given scale. */
export interface PageDimensions {
  width: number;
  height: number;
}

export interface RenderPageOptions {
  scale: number;
  canvas: HTMLCanvasElement;
  /** Abort an in-flight render (e.g. when the page scrolls out of view). */
  signal?: AbortSignal;
}

/** A rasterised page image (e.g. for OCR): a PNG data URL plus its pixel size. */
export interface PageImage {
  dataUrl: string;
  width: number;
  height: number;
}

/** A text-search hit. */
export interface SearchMatch {
  /** 1-based page number. */
  pageNumber: number;
  /** Character offset of the match within the page's extracted text. */
  index: number;
  /** Surrounding text, for display in the results list. */
  snippet: string;
}
