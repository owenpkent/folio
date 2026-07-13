/** Extracted text for one page. */
export interface PageText {
  pageNumber: number;
  text: string;
}

/**
 * A reviewer's sticky note, resolved to something an AI can locate: the page,
 * the anchor position (page fractions), the comment, and the page text the note
 * sits next to (captured when it was placed).
 */
export interface NoteAnchor {
  page: number;
  /** Anchor position as page fractions (0 = left/top, 1 = right/bottom). */
  x: number;
  y: number;
  comment: string;
  nearText: string;
}

/** The document text the AI layer operates on. Nothing binary is ever sent. */
export interface DocumentText {
  name: string;
  pages: PageText[];
  fullText: string;
  /** Reviewer notes, if any, so the AI can answer/act on them in context. */
  notes?: NoteAnchor[];
}

export interface AiRequestOptions {
  signal?: AbortSignal;
}

/**
 * A pluggable AI backend. Folio ships a Claude provider; others (local models,
 * other vendors) can implement this same interface. See docs/ai.md.
 *
 * Streaming methods return an async iterable of text chunks so the UI can render
 * tokens as they arrive.
 */
export interface AIProvider {
  readonly id: string;
  readonly name: string;

  /** True once the provider has the credentials/config it needs to run. */
  isConfigured(): boolean;

  summarize(doc: DocumentText, opts?: AiRequestOptions): AsyncIterable<string>;
  ask(question: string, context: DocumentText, opts?: AiRequestOptions): AsyncIterable<string>;
  extract(schema: object, context: DocumentText, opts?: AiRequestOptions): Promise<unknown>;
}

export class AiNotConfiguredError extends Error {
  constructor(providerName: string) {
    super(`${providerName} is not configured. Add an API key in settings to enable AI features.`);
    this.name = 'AiNotConfiguredError';
  }
}
