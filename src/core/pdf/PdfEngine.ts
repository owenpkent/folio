import type {
  DocumentSource,
  OutlineNode,
  PageDimensions,
  PdfDocumentInfo,
  PdfMetadata,
  RenderPageOptions,
  SearchMatch,
} from './types';

/**
 * The rendering contract the UI depends on.
 *
 * A single implementation ({@link PdfJsEngine}) is active at a time and holds
 * one open document. Keeping this interface narrow is what lets us replace the
 * backend later (e.g. a WASM PDFium engine) without changing any component.
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
   * Build the selectable, screen-reader-readable text overlay for a page into
   * `container`. This is what makes the viewer accessible: real DOM text
   * positioned over the rasterised page.
   */
  renderTextLayer(pageNumber: number, container: HTMLElement, scale: number): Promise<void>;

  /**
   * Render the interactive annotation layer for a page: fillable AcroForm
   * widgets (text fields, checkboxes, radios, dropdowns) and link annotations.
   * Edits flow into the engine's annotation storage and are written out by
   * {@link saveDocument}.
   */
  renderAnnotationLayer(pageNumber: number, container: HTMLElement, scale: number): Promise<void>;

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

  /** The document outline / bookmarks, flattened to a tree of {@link OutlineNode}. */
  getOutline(): Promise<OutlineNode[]>;

  /** Document metadata. */
  getMetadata(): Promise<PdfMetadata>;

  /** Case-insensitive plain-text search across the document. */
  search(query: string, options?: { limit?: number }): Promise<SearchMatch[]>;
}
