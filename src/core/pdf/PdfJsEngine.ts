// The legacy bundle, for the reason setupWorker.ts spells out. Types still come
// from the package root: `legacy/build/pdf.d.mts` is a bare re-export of them.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  PageViewport,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist';

import { LruMap } from '@/core/lru';

import type { PageTextItems, PdfEngine } from './PdfEngine';
import { ensureWorker, pdfWasmUrl } from './setupWorker';
import type {
  DocumentSource,
  OutlineNode,
  PageDimensions,
  PageImage,
  PageLink,
  PdfDocumentInfo,
  PdfMetadata,
  RenderLayerOptions,
  RenderPageOptions,
  SearchMatch,
} from './types';

/**
 * Lowest backing-store scale to render at, whatever the display reports. A 1x
 * panel still benefits from a supersampled store downsampled into the canvas's
 * CSS size, which is what keeps text crisp where the platform under-reports DPI
 * (WebView2 under Windows scaling) as well as on genuinely 1x screens.
 */
const SUPERSAMPLE_MIN = 2;

// Canvas backing-store budget. pdf.js's low-level render API enforces no limit,
// so we cap it ourselves: past the browser's canvas ceiling the page is silently
// downscaled (blur) and memory balloons. 2^24 px matches pdf.js's own viewer
// default (`maxCanvasPixels`); 4096 per side stays well under every engine's
// max-dimension limit (Chromium/WebKit ~16k, but large canvases get unstable).
const MAX_CANVAS_AREA = 16_777_216; // 2 ** 24
const MAX_CANVAS_DIM = 4096;

/**
 * The scale to rasterise a page's backing store at, given its CSS size and the
 * display's pixel ratio. Exported for tests: the two competing pressures here
 * (be at least as dense as the display, stay inside the canvas budget) are what
 * issue #29 was about, and they are worth pinning down.
 *
 * Supersamples toward crisp: at least SUPERSAMPLE_MIN, so even a 1x panel gets a
 * higher-resolution store to downsample from, and never below the display's own
 * density, so a 4x panel is not handed a 3x render it has to stretch. There is
 * deliberately no ceiling of its own -- the budget below is the one bound, and a
 * second, smaller ceiling only served to under-render the densest displays.
 *
 * The budget then wins unconditionally: past roughly 5x zoom a page's CSS layout
 * size alone exceeds it, so any floor (even 1x) would hand the browser an
 * oversized canvas that it silently downscales anyway (blur) while burning the
 * memory the cap exists to bound. There, a sub-density render is the honest
 * outcome and the browser upsamples.
 */
export function backingStoreScale(cssWidth: number, cssHeight: number, dpr: number): number {
  const target = Math.max(SUPERSAMPLE_MIN, dpr);
  const cap = Math.min(
    MAX_CANVAS_DIM / Math.max(cssWidth, cssHeight),
    Math.sqrt(MAX_CANVAS_AREA / (cssWidth * cssHeight)),
  );
  return Math.min(target, cap);
}

/**
 * Cache bounds. These were unbounded Maps cleared only when the document
 * closed, so opening a long document and scrolling through it pinned one entry
 * per page for the session.
 *
 * The page bound must comfortably exceed the live set or evictions thrash: an
 * evicted page re-renders from a refetched operator list. pdf.js's own viewer
 * sizes its equivalent at max(10, 2 * visible + 1); this is larger again to
 * cover the 600px prefetch ring in Page.tsx and the 300px one in Thumbnails.
 */
const PAGE_CACHE_LIMIT = 24;
/** Text items (glyph positions and styles) are much the heaviest of the three,
 *  and the text-edit layer consumes them one page at a time. */
const TEXT_ITEMS_CACHE_LIMIT = 24;
/** Plain per-page strings, a few KB each, but whole-document consumers (search,
 *  word count, the AI context builder) walk every page, so keep this generous. */
const TEXT_CACHE_LIMIT = 512;

// PDF.js raw outline items, typed loosely to avoid depending on internals.
interface RawOutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items?: RawOutlineItem[];
}

/** The parts of a PDF.js annotation a link needs, typed the same loose way. */
interface RawLinkAnnotation {
  subtype?: string;
  /** Present only when PDF.js accepted the target's protocol. */
  url?: string;
  rect?: number[];
}

/** The PDF.js-backed {@link PdfEngine}. */
export class PdfJsEngine implements PdfEngine {
  private doc: PDFDocumentProxy | null = null;
  // Held because PDF.js 6 removed `PDFDocumentProxy.destroy()`; tearing down the
  // loading task is what releases the worker and the transport now. Kept
  // separately from `doc` so a document that failed to load is still torn down.
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private name = '';
  /**
   * Evicting a page from this map frees nothing on its own: pdf.js memoizes
   * every page it hands out in its own WorkerTransport cache, which lives until
   * the document is destroyed, so our entry is only a second reference to
   * something already pinned. `cleanup()` is the call that actually releases
   * anything -- it drops the cached operator list and the page's decoded images
   * and fonts. It leaves the proxy usable (viewport, text, annotations and
   * render all still work; the next render just refetches), and it is a no-op
   * returning false while a render is in flight, which is the behaviour we want
   * for a page that is being evicted precisely because it went off screen.
   */
  private pageCache = new LruMap<number, PDFPageProxy>(PAGE_CACHE_LIMIT, (page) => {
    page.cleanup();
  });
  private textCache = new LruMap<number, string>(TEXT_CACHE_LIMIT);
  /** Tiny per page, and hovering an address samples this on every frame. */
  private linkCache = new LruMap<number, PageLink[]>(TEXT_CACHE_LIMIT);
  private textItemsCache = new LruMap<number, PageTextItems>(TEXT_ITEMS_CACHE_LIMIT);
  private readonly linkService = createLinkService();

  get isReady(): boolean {
    return this.doc !== null;
  }

  async loadDocument(source: DocumentSource): Promise<PdfDocumentInfo> {
    ensureWorker();
    await this.closeDocument();

    // Note `data` is TRANSFERRED to the worker, not copied: pdf.js passes
    // [data.buffer] as the transfer list, so the caller's view is detached the
    // moment this runs. Anything that needs the original bytes has to read them
    // before calling this, which is what actions.ts does for signature
    // detection. Keeping a defensive .slice() here instead cost a second full
    // copy of the file, resident for the whole session, to serve one caller
    // that wanted three fields out of it.
    const params = source.kind === 'bytes' ? { data: source.data } : { url: source.url };
    // wasmUrl is what lets the worker decode JBIG2 and JPEG2000 images, i.e.
    // most scanned documents; see setupWorker.ts for where the files come from.
    this.loadingTask = pdfjsLib.getDocument({ ...params, wasmUrl: pdfWasmUrl() });
    this.doc = await this.loadingTask.promise;
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
    this.linkCache.clear();
    this.textItemsCache.clear();
    this.doc = null;
    if (this.loadingTask) {
      // Null the field first: destroy() awaits the worker round-trip, and a
      // second close (or a reload) arriving meanwhile must not destroy it twice.
      const task = this.loadingTask;
      this.loadingTask = null;
      await task.destroy();
    }
  }

  async getPageDimensions(pageNumber: number, scale: number): Promise<PageDimensions> {
    const page = await this.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    return { width: viewport.width, height: viewport.height };
  }

  async renderPage(pageNumber: number, options: RenderPageOptions): Promise<void> {
    const { scale, canvas, signal, overlayForms = false, invert = false, tint } = options;
    const page = await this.getPage(pageNumber);
    // Bail before sizing the canvas below, the way the layer renders do after
    // their own awaits. A page scrolled away mid-fetch has already had its
    // backing store zeroed by the caller, so resizing it here would re-allocate
    // the raster for a page nobody is looking at, and nothing would zero it a
    // second time, so scrolling quickly through a long document leaked a
    // full-size canvas per page passed.
    if (signal?.aborted) return;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not acquire a 2D canvas context');

    // Rasterise above the display density (so text stays crisp even when the
    // platform under-reports DPI — e.g. WebView2 under Windows scaling — and on
    // plain 1x panels) and let the browser downsample the backing store into the
    // canvas's CSS size. Crucially, clamp the backing store to a pixel BUDGET and
    // a max DIMENSION: the low-level pdf.js API enforces neither, and a canvas
    // past the browser's limit gets silently downscaled (blur) and burns memory.
    const viewport = page.getViewport({ scale });
    const outputScale = backingStoreScale(
      viewport.width,
      viewport.height,
      window.devicePixelRatio || 1,
    );

    canvas.width = Math.round(viewport.width * outputScale);
    canvas.height = Math.round(viewport.height * outputScale);
    // CSS size is the layout size (matches the text layer and page box exactly);
    // the larger backing store is downsampled into it.
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const transform = [outputScale, 0, 0, outputScale, 0, 0];
    const task = page.render({
      // v6 takes the canvas, not the context (`canvasContext` is the
      // back-compat path now and is ignored whenever `canvas` is set). PDF.js
      // calls getContext('2d') itself; because we already did, above, it gets
      // handed back the very same context object the invert pass below writes
      // to, with the attributes of that first call.
      canvas,
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

    await page.render({ canvas, viewport }).promise;
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
      setLayerScale(container, viewport);

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

      const flipped = viewport.clone({ dontFlip: true });
      container.replaceChildren();
      setLayerScale(container, flipped);

      const layer = new pdfjsLib.AnnotationLayer({
        div: container as HTMLDivElement,
        accessibilityManager: null,
        annotationCanvasMap: null,
        annotationEditorUIManager: null,
        page,
        viewport: flipped,
        structTreeLayer: null,
        // v6 moved these three off render() and onto the constructor. The last
        // two only look optional. Without a link service the first Link
        // annotation throws on getDestinationHash and rejects the whole pass,
        // taking every AcroForm widget on the page down with it. Without the
        // document's own storage the layer quietly allocates a private
        // AnnotationStorage, so typing in a field never reaches
        // doc.annotationStorage: getPendingEditCount() stays at 0 and
        // saveDocument() writes the field back out empty.
        commentManager: null,
        linkService: this.linkService,
        annotationStorage: doc.annotationStorage,
      });

      // render() now reads div / page / viewport / linkService / storage off the
      // instance, so only the per-pass options are left here. Still cast: the
      // published type keeps describing the v4 parameter object.
      await layer.render({
        annotations,
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

  async getPageLinks(pageNumber: number): Promise<PageLink[]> {
    const cached = this.linkCache.get(pageNumber);
    if (cached) return cached;

    const page = await this.getPage(pageNumber);
    const annotations = await page.getAnnotations({ intent: 'display' });

    const links: PageLink[] = [];
    for (const annotation of annotations as RawLinkAnnotation[]) {
      // `url` is set only when PDF.js's own protocol allow-list accepted the
      // action's target; `unsafeUrl` is the document's unchecked original and is
      // deliberately never read here. An internal /GoTo link has neither.
      if (annotation.subtype !== 'Link' || !annotation.url) continue;
      const rect = annotation.rect;
      if (!Array.isArray(rect) || rect.length !== 4) continue;
      links.push({ url: annotation.url, rect: [rect[0], rect[1], rect[2], rect[3]] });
    }
    this.linkCache.set(pageNumber, links);
    return links;
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

/**
 * Declare the scale the layer CSS positions itself against.
 *
 * PDF.js's stylesheet keys everything off `--total-scale-factor` as of v6 (v4
 * used `--scale-factor` directly): text-layer spans take their font size from
 * it, and `setLayerDimensions` -- which both TextLayer and AnnotationLayer call
 * on the container -- sizes the layer box with
 * `round(down, var(--total-scale-factor) * Npx, var(--scale-round-x))`, which
 * computes to nothing at all if either property is missing. PDF.js's own viewer
 * declares them on its `.pdfViewer .page` wrapper; Folio mounts the layers on
 * its own page element, so they have to be set here.
 *
 * The total is scale x the page's /UserUnit, matching what PageViewport itself
 * multiplied the page box by, so the CSS box lines up with the canvas.
 */
function setLayerScale(container: HTMLElement, viewport: PageViewport): void {
  const { style } = container;
  style.setProperty('--scale-factor', String(viewport.scale));
  style.setProperty('--user-unit', String(viewport.userUnit));
  style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit));
  // Device-pixel snapping, which the viewer recomputes per page; Folio does not
  // snap, so 1px (a no-op round) keeps the expression valid.
  style.setProperty('--scale-round-x', '1px');
  style.setProperty('--scale-round-y', '1px');
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
