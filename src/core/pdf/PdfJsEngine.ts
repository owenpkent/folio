import * as pdfjsLib from 'pdfjs-dist';
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

import type { PageTextItems, PdfEngine } from './PdfEngine';
import { ensureWorker } from './setupWorker';
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

// Canvas backing-store budget. pdf.js's low-level render API enforces no limit,
// so we cap it ourselves: past the browser's canvas ceiling the page is silently
// downscaled (blur) and memory balloons. 2^24 px matches pdf.js's own viewer
// default (`maxCanvasPixels`); 4096 per side stays well under every engine's
// max-dimension limit (Chromium/WebKit ~16k, but large canvases get unstable).
const MAX_CANVAS_AREA = 16_777_216; // 2 ** 24
const MAX_CANVAS_DIM = 4096;

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
  private sourceBytes: Uint8Array | null = null;
  private pageCache = new Map<number, PDFPageProxy>();
  private textCache = new Map<number, string>();
  private textItemsCache = new Map<number, PageTextItems>();
  private readonly linkService = createLinkService();

  get isReady(): boolean {
    return this.doc !== null;
  }

  async loadDocument(source: DocumentSource): Promise<PdfDocumentInfo> {
    ensureWorker();
    await this.closeDocument();

    // Keep an untouched copy of the bytes before PDF.js can transfer/detach the
    // buffer; signature detection needs the exact original file.
    this.sourceBytes = source.kind === 'bytes' ? source.data.slice() : null;

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
    this.textItemsCache.clear();
    this.sourceBytes = null;
    if (this.doc) {
      await this.doc.destroy();
      this.doc = null;
    }
  }

  getOriginalBytes(): Uint8Array | null {
    return this.sourceBytes;
  }

  async getPageDimensions(pageNumber: number, scale: number): Promise<PageDimensions> {
    const page = await this.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    return { width: viewport.width, height: viewport.height };
  }

  async renderPage(pageNumber: number, options: RenderPageOptions): Promise<void> {
    const { scale, canvas, signal, overlayForms = false, invert = false, tint } = options;
    const page = await this.getPage(pageNumber);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not acquire a 2D canvas context');

    // Rasterise above the display density (so text stays crisp even when the
    // platform under-reports DPI — e.g. WebView2 under Windows scaling — and on
    // plain 1x panels) and let the browser downsample the backing store into the
    // canvas's CSS size. Crucially, clamp the backing store to a pixel BUDGET and
    // a max DIMENSION: the low-level pdf.js API enforces neither, and a canvas
    // past the browser's limit gets silently downscaled (blur) and burns memory.
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    const target = Math.min(3, Math.max(2, dpr)); // supersample toward crisp
    // Hard ceiling on the backing store: the tighter of the max-per-side and
    // pixel-budget limits. It has to win unconditionally — past ~5x zoom the
    // page's CSS layout size alone already exceeds the budget, so any floor
    // (even 1x) would bust the cap and hand the browser an oversized canvas it
    // silently downscales anyway (blur) while burning the memory the cap exists
    // to bound. There we accept a sub-1x, browser-downsampled render instead.
    const cap = Math.min(
      MAX_CANVAS_DIM / Math.max(viewport.width, viewport.height),
      Math.sqrt(MAX_CANVAS_AREA / (viewport.width * viewport.height)),
    );
    // Aim for `target` (>= 2x, so normal pages never drop below CSS resolution),
    // but never above the cap.
    const outputScale = Math.min(target, cap);

    canvas.width = Math.round(viewport.width * outputScale);
    canvas.height = Math.round(viewport.height * outputScale);
    // CSS size is the layout size (matches the text layer and page box exactly);
    // the larger backing store is downsampled into it.
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const transform = [outputScale, 0, 0, outputScale, 0, 0];
    const task = page.render({
      canvasContext: context,
      viewport,
      transform,
      // ENABLE_FORMS is what makes PDF.js skip the widgets it expects the
      // annotation layer to draw as DOM inputs; plain ENABLE bakes their values
      // into the canvas, where they show through the inputs as doubled text.
      // It has to be ENABLE_FORMS specifically: the worker gates that skip on
      // the ANNOTATIONS_FORMS intent flag, and ENABLE_STORAGE sets a different
      // flag (ANNOTATIONS_STORAGE), so it would paint the widgets after all.
      annotationMode: overlayForms
        ? pdfjsLib.AnnotationMode.ENABLE_FORMS
        : pdfjsLib.AnnotationMode.ENABLE,
    });
    // Registered after the awaits above, so a signal that aborted while we were
    // fetching the page would never reach the task.
    if (signal?.aborted) task.cancel();
    else signal?.addEventListener('abort', () => task.cancel(), { once: true });

    try {
      await task.promise;
    } catch (error) {
      // A cancelled render is expected when a page scrolls out of view.
      if ((error as { name?: string })?.name !== 'RenderingCancelledException') {
        throw error;
      }
      return;
    }

    // Dark mode: invert the freshly-painted pixels at full backing-store
    // resolution. `difference` with white computes |255 - channel| per pixel —
    // exactly invert(1) — but on the real canvas, so it never triggers the
    // CSS-filter path that some engines re-rasterise at CSS resolution (blur).
    if (invert && !signal?.aborted) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalCompositeOperation = 'difference';
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      // A green/amber reading scheme: multiply the inverted page by the tint so
      // the (now white) ink takes the colour while black stays black. Multiply
      // scales each channel, so anti-aliased edges become a gradient of the tint
      // rather than a hard mask.
      if (tint) {
        context.globalCompositeOperation = 'multiply';
        context.fillStyle = `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.restore();
    }
  }

  async renderPageToImage(pageNumber: number, scale: number): Promise<PageImage> {
    const page = await this.getPage(pageNumber);
    const viewport = page.getViewport({ scale });

    // A detached canvas rendered at exactly `scale` (no devicePixelRatio
    // multiplier) so OCR sees a predictable pixel grid for its bounding boxes.
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not acquire a 2D canvas context');

    await page.render({ canvasContext: context, viewport }).promise;
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  }

  async renderTextLayer(
    pageNumber: number,
    container: HTMLElement,
    options: RenderLayerOptions,
  ): Promise<void> {
    const { scale, signal } = options;
    await serializePerContainer(container, async () => {
      const page = await this.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const textContentSource = await page.getTextContent();
      if (signal?.aborted) return;

      container.replaceChildren();
      // PDF.js positions text-layer spans relative to this custom property.
      container.style.setProperty('--scale-factor', String(scale));

      const textLayer = new pdfjsLib.TextLayer({ textContentSource, container, viewport });
      await textLayer.render();
    });
  }

  async renderAnnotationLayer(
    pageNumber: number,
    container: HTMLElement,
    options: RenderLayerOptions,
  ): Promise<void> {
    const { scale, signal } = options;
    await serializePerContainer(container, async () => {
      const doc = this.requireDoc();
      const page = await this.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const annotations = await page.getAnnotations({ intent: 'display' });
      // A superseded pass must not start appending: AnnotationLayer.render()
      // appends across await points, so two passes sharing this div would
      // interleave and leave duplicate widgets behind.
      if (signal?.aborted) return;

      container.replaceChildren();
      container.style.setProperty('--scale-factor', String(scale));

      const layer = new pdfjsLib.AnnotationLayer({
        div: container as HTMLDivElement,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        page,
        viewport: viewport.clone({ dontFlip: true }),
        structTreeLayer: null,
      });

      await layer.render({
        annotations,
        div: container as HTMLDivElement,
        page,
        viewport: viewport.clone({ dontFlip: true }),
        linkService: this.linkService,
        annotationStorage: doc.annotationStorage,
        renderForms: true,
        enableScripting: false,
        hasJSActions: false,
      } as unknown as Parameters<pdfjsLib.AnnotationLayer['render']>[0]);

      nameFormWidgets(container, annotations);
    });
  }

  async hasFormFields(): Promise<boolean> {
    const doc = this.requireDoc();
    const fields = await doc.getFieldObjects();
    return fields != null && Object.keys(fields).length > 0;
  }

  getPendingEditCount(): number {
    return this.doc ? this.doc.annotationStorage.size : 0;
  }

  async saveDocument(): Promise<Uint8Array> {
    return this.requireDoc().saveDocument();
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

  async getPageViewport(pageNumber: number, scale: number): Promise<PageViewport> {
    const page = await this.getPage(pageNumber);
    return page.getViewport({ scale });
  }

  async getTextItems(pageNumber: number): Promise<PageTextItems> {
    const cached = this.textItemsCache.get(pageNumber);
    if (cached) return cached;

    const page = await this.getPage(pageNumber);
    const { items, styles } = await page.getTextContent();
    const result: PageTextItems = { items, styles };
    this.textItemsCache.set(pageNumber, result);
    return result;
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

/** The subset of PDF.js's annotation data this file relies on. */
interface AnnotationData {
  id: string;
  /** The field's /TU entry: the human-readable label its author gave it. */
  alternativeText?: string;
  /** The field's /T entry, e.g. "topmostSubform[0].Page1[0].name[0]". */
  fieldName?: string;
}

/**
 * Give each form control an accessible name taken from its PDF field.
 *
 * PDF.js does not do this itself. It applies ARIA to a widget in exactly one
 * place — `AnnotationLayer.#appendElement`, from
 * `structTreeLayer.getAriaAttributes()` — which is inert for us because we
 * render without a structure tree. Its only other use of the label is
 * `container.title = data.alternativeText`, and that lands on the wrapping
 * `<section>`: `title` on an *ancestor* is not an accessible-name source, so the
 * `<input>` inside is left anonymous even when the PDF names the field properly.
 * Without this pass every field in a document reads as an unlabeled edit box,
 * which fails WCAG 2.2 SC 4.1.2 (Name, Role, Value, Level A).
 *
 * Widgets are found via the rendered controls rather than by testing
 * `annotationType === AnnotationType.WIDGET`, since PDF.js does not export that
 * enum: an annotation with a form control in its section is a widget.
 */
function nameFormWidgets(container: HTMLElement, annotations: AnnotationData[]): void {
  const byId = new Map(annotations.map((a) => [a.id, a]));

  for (const section of container.querySelectorAll<HTMLElement>('[data-annotation-id]')) {
    const control = section.querySelector<HTMLElement>('input, select, textarea');
    const annotation = byId.get(section.dataset.annotationId ?? '');
    if (!control || !annotation) continue;
    // Never override a name PDF.js (or a future struct-tree pass) already set.
    if (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) continue;

    // /TU is the author's own label and the entry PDF/UA leans on for fields
    // (ISO 32000-1 14.9.3, via Matterhorn 28-005). /T is a fallback: often
    // machine-ish ("Text1"), but a poor name beats no name.
    const name = annotation.alternativeText?.trim() || annotation.fieldName?.trim();
    if (name) control.setAttribute('aria-label', name);
  }
}

/**
 * In-flight layer render per container element.
 *
 * PDF.js builds the text and annotation layers by appending across `await`
 * points, so two overlapping renders into one element interleave: the newer
 * one's `replaceChildren()` lands mid-loop and the older one's remaining
 * appends survive it, leaving duplicated widgets stacked at the same
 * coordinates. Neither layer API exposes a way to cancel mid-loop, so renders
 * are queued instead: the next pass starts only once the previous has finished
 * (and then bails immediately if its signal aborted in the meantime).
 */
const layerRenders = new WeakMap<HTMLElement, Promise<void>>();

function serializePerContainer(container: HTMLElement, run: () => Promise<void>): Promise<void> {
  const previous = layerRenders.get(container) ?? Promise.resolve();
  // Errors are the caller's to handle; they must not break the chain for the
  // renders queued behind this one.
  const next = previous.catch(() => {}).then(run);
  layerRenders.set(container, next.catch(() => {}));
  return next;
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

/**
 * A minimal link service for the annotation layer. Form widgets need one to be
 * present; external links open in a new window. Internal navigation is not
 * wired up here (the viewer handles page navigation elsewhere).
 */
function createLinkService() {
  return {
    externalLinkEnabled: true,
    externalLinkTarget: 2, // LinkTarget.BLANK
    externalLinkRel: 'noopener noreferrer nofollow',
    isInPresentationMode: false,
    pagesCount: 0,
    page: 0,
    rotation: 0,
    getDestinationHash: () => '',
    getAnchorUrl: (url: string) => url,
    addLinkAttributes: (link: HTMLAnchorElement, url: string, newWindow?: boolean) => {
      link.href = url || '';
      link.rel = 'noopener noreferrer nofollow';
      link.target = newWindow ? '_blank' : '';
    },
    setHash: () => {},
    executeNamedAction: () => {},
    executeSetOCGState: () => {},
    goToDestination: async () => {},
    goToPage: () => {},
  };
}
