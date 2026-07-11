import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

import type { PdfEngine } from './PdfEngine';
import { ensureWorker } from './setupWorker';
import type {
  DocumentSource,
  OutlineNode,
  PageDimensions,
  PdfDocumentInfo,
  PdfMetadata,
  RenderPageOptions,
  SearchMatch,
} from './types';

// PDF.js raw outline items, typed loosely to avoid depending on internals.
interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

/** The PDF.js-backed {@link PdfEngine}. */
export class PdfJsEngine implements PdfEngine {
  private doc: PDFDocumentProxy | null = null;
  private name = '';
  private pageCache = new Map<number, PDFPageProxy>();
  private textCache = new Map<number, string>();

  get isReady(): boolean {
    return this.doc !== null;
  }

  async loadDocument(source: DocumentSource): Promise<PdfDocumentInfo> {
    ensureWorker();
    await this.closeDocument();

    const params = source.kind === 'bytes' ? { data: source.data } : { url: source.url };
    this.doc = await pdfjsLib.getDocument(params).promise;
    this.name = source.name ?? 'Untitled.pdf';

    return {
      numPages: this.doc.numPages,
      fingerprint: this.doc.fingerprints?.[0] ?? '',
      name: this.name,
    };
  }

  async closeDocument(): Promise<void> {
    this.pageCache.clear();
    this.textCache.clear();
    if (this.doc) {
      await this.doc.destroy();
      this.doc = null;
    }
  }

  async getPageDimensions(pageNumber: number, scale: number): Promise<PageDimensions> {
    const page = await this.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    return { width: viewport.width, height: viewport.height };
  }

  async renderPage(pageNumber: number, options: RenderPageOptions): Promise<void> {
    const { scale, canvas, signal } = options;
    const page = await this.getPage(pageNumber);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not acquire a 2D canvas context');

    // Render at device-pixel resolution for crisp text on HiDPI displays,
    // then scale the canvas back down via CSS.
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;
    const task = page.render({ canvasContext: context, viewport, transform });
    signal?.addEventListener('abort', () => task.cancel(), { once: true });

    try {
      await task.promise;
    } catch (error) {
      // A cancelled render is expected when a page scrolls out of view.
      if ((error as { name?: string })?.name !== 'RenderingCancelledException') {
        throw error;
      }
    }
  }

  async renderTextLayer(pageNumber: number, container: HTMLElement, scale: number): Promise<void> {
    const page = await this.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    container.replaceChildren();
    // PDF.js positions text-layer spans relative to this custom property.
    container.style.setProperty('--scale-factor', String(scale));

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: await page.getTextContent(),
      container,
      viewport,
    });
    await textLayer.render();
  }

  async getPageText(pageNumber: number): Promise<string> {
    const cached = this.textCache.get(pageNumber);
    if (cached !== undefined) return cached;

    const page = await this.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    this.textCache.set(pageNumber, text);
    return text;
  }

  async getOutline(): Promise<OutlineNode[]> {
    const doc = this.requireDoc();
    const raw = (await doc.getOutline()) as RawOutlineItem[] | null;
    if (!raw) return [];

    const resolve = async (items: RawOutlineItem[]): Promise<OutlineNode[]> =>
      Promise.all(
        items.map(async (item) => ({
          title: item.title,
          pageNumber: await destToPageNumber(doc, item.dest),
          children: item.items?.length ? await resolve(item.items) : [],
        })),
      );

    return resolve(raw);
  }

  async getMetadata(): Promise<PdfMetadata> {
    const doc = this.requireDoc();
    const { info } = await doc.getMetadata();
    const i = (info ?? {}) as Record<string, string>;
    return {
      title: i.Title,
      author: i.Author,
      subject: i.Subject,
      keywords: i.Keywords,
      creator: i.Creator,
      producer: i.Producer,
      creationDate: i.CreationDate,
      modificationDate: i.ModDate,
      pageCount: doc.numPages,
    };
  }

  async search(query: string, options?: { limit?: number }): Promise<SearchMatch[]> {
    const doc = this.requireDoc();
    const needle = query.trim().toLowerCase();
    const matches: SearchMatch[] = [];
    if (!needle) return matches;

    const limit = options?.limit ?? 200;
    for (let pageNumber = 1; pageNumber <= doc.numPages && matches.length < limit; pageNumber++) {
      const text = await this.getPageText(pageNumber);
      const haystack = text.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index !== -1 && matches.length < limit) {
        matches.push({ pageNumber, index, snippet: buildSnippet(text, index, needle.length) });
        index = haystack.indexOf(needle, index + needle.length);
      }
    }
    return matches;
  }

  private requireDoc(): PDFDocumentProxy {
    if (!this.doc) throw new Error('No document is loaded');
    return this.doc;
  }

  private async getPage(pageNumber: number): Promise<PDFPageProxy> {
    const cached = this.pageCache.get(pageNumber);
    if (cached) return cached;
    const page = await this.requireDoc().getPage(pageNumber);
    this.pageCache.set(pageNumber, page);
    return page;
  }
}

/** Resolve a PDF destination to a 1-based page number, best effort. */
async function destToPageNumber(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  try {
    if (!dest) return null;
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const ref = explicit[0];
    if (ref && typeof ref === 'object') {
      const pageIndex = await doc.getPageIndex(
        ref as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
      return pageIndex + 1;
    }
    return null;
  } catch {
    return null;
  }
}

/** Build a trimmed context window around a search hit. */
function buildSnippet(text: string, index: number, length: number): string {
  const radius = 40;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const lead = start > 0 ? '…' : '';
  const trail = end < text.length ? '…' : '';
  return `${lead}${text.slice(start, end).trim()}${trail}`;
}
