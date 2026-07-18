import type { PageViewport, PDFPageProxy } from 'pdfjs-dist';

import type {
  DocumentSource,
  OutlineNode,
  PageDimensions,
  PageImage,
  PdfDocumentInfo,
  PdfMetadata,
  RenderLayerOptions,
  RenderPageOptions,
  SearchMatch,
} from './types';

/**
 * PDF.js's per-item text content for a page. Derived from {@link PDFPageProxy}
 * rather than imported directly: pdfjs-dist does not re-export TextItem /
 * TextStyle from its package root, only from internal module paths.
 */
type PageTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

/**
 * A page's raw text runs plus the per-font styles PDF.js resolved for them.
 * Exposed so features/textedit can hit-test clicks against the same items
 * PDF.js used to build the text layer, and recover font family/size for the
 * inline editor it opens.
 */
export interface PageTextItems {
  items: PageTextContent['items'];
  styles: PageTextContent['styles'];
}

/**
 * The rendering contract the UI depends on.
 *
 * A single implementation ({@link PdfJsEngine}) is active at a time and holds
 * one open document. Keeping this interface narrow is what lets us replace the
 * backend later (e.g. a WASM PDFium engine) without changing any component.
 *
 * {@link getPageViewport} and {@link getTextItems} are a deliberate exception:
 * features/textedit edits PDF content streams directly and must hit-test
 * clicks against the exact items and coordinate space PDF.js used to build the
 * text layer, so it leaks PDF.js-specific types rather than re-abstracting them.
 */
export interface PdfEngine {
  /** True once a document has loaded and the other methods are usable. */
  readonly isReady: boolean;

  /** Load a document, replacing any currently open one. */
  loadDocument(source: DocumentSource): Promise<PdfDocumentInfo>;

  /** Release the current document and any cached resources. */
  closeDocument(): Promise<void>;

  /** CSS-pixel dimensions of a page at the given scale. */
  getPageDimensions(pageNumber: number, scale: number): Promise<PageDimensions>;

  /** Paint a page onto a canvas. Resolves when the render completes. */
  renderPage(pageNumber: number, options: RenderPageOptions): Promise<void>;

  /**
   * Rasterise a page to a standalone PNG image at the given scale (no HiDPI
   * multiplier). Used by OCR to recognise scanned pages.
   */
  renderPageToImage(pageNumber: number, scale: number): Promise<PageImage>;

  /**
   * Build the selectable, screen-reader-readable text overlay for a page into
   * `container`. This is what makes the viewer accessible: real DOM text
   * positioned over the rasterised page.
   */
  renderTextLayer(
    pageNumber: number,
    container: HTMLElement,
    options: RenderLayerOptions,
  ): Promise<void>;

  /**
   * Render the interactive annotation layer for a page: fillable AcroForm
   * widgets (text fields, checkboxes, radios, dropdowns) and link annotations.
   * Edits flow into the engine's annotation storage and are written out by
   * {@link saveDocument}.
   */
  renderAnnotationLayer(
    pageNumber: number,
    container: HTMLElement,
    options: RenderLayerOptions,
  ): Promise<void>;

  /** Whether the document contains fillable AcroForm fields. */
  hasFormFields(): Promise<boolean>;

  /** Count of pending in-memory edits (filled fields not yet saved). */
  getPendingEditCount(): number;

  /** Export the current document, with filled form values, as PDF bytes. */
  saveDocument(): Promise<Uint8Array>;

  /** The original bytes the document was loaded from (for signature detection). */
  getOriginalBytes(): Uint8Array | null;

  /** Extracted plain text for a page (used by search and the AI layer). */
  getPageText(pageNumber: number): Promise<string>;

  /**
   * The page's viewport at `scale`, for converting between screen (CSS pixel)
   * and PDF user-space coordinates via its `convertToPdfPoint` /
   * `convertToViewportRectangle` helpers.
   */
  getPageViewport(pageNumber: number, scale: number): Promise<PageViewport>;

  /**
   * Raw per-item text content for a page (position, size, font, string).
   * Cached like {@link getPageText}.
   */
  getTextItems(pageNumber: number): Promise<PageTextItems>;

  /** The document outline / bookmarks, flattened to a tree of {@link OutlineNode}. */
  getOutline(): Promise<OutlineNode[]>;

  /** Document metadata. */
  getMetadata(): Promise<PdfMetadata>;

  /** Case-insensitive plain-text search across the document. */
  search(query: string, options?: { limit?: number }): Promise<SearchMatch[]>;
}
