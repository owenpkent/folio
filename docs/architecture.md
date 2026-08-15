# Folio Architecture

Folio is a desktop PDF viewer built on **Tauri 2** (Rust backend) with a **React 19 + TypeScript 5** frontend, bundled by **Vite 8** (rolldown-based). Rendering is delegated to **PDF.js** (`pdfjs-dist` v6). Application state lives in **Zustand** stores. Theming is driven entirely by **CSS custom properties**.

This document describes the layer stack, the data flow for opening and rendering a PDF, the engine abstraction, the PDF.js worker threading model, state management, extension points, and the Tauri command boundary.

## Design goals that shaped the architecture

- **Fast rendering.** Parsing and rasterization happen off the UI thread. The main thread only paints canvases and manages the DOM.
- **Accessibility-first (WCAG 2.2 AA).** Every rendered page carries a real text layer for selection and screen-reader access. Every user action is a `Command` with a keybinding.
- **Dark-mode native.** Theme tokens and a raster-time page inversion are first-class, not bolted on.
- **Extensible.** A plugin host exposes stable SDK surfaces (commands, viewer regions, theme tokens) so third parties extend Folio without forking.
- **AI-ready.** A provider-agnostic AI layer sits behind an interface, with Claude/Anthropic as the default provider and MCP planned as an experimental transport.

## Layer stack

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Tauri 2 shell (native window)                     │
│  WebView (Chromium/WebKit)                          Rust backend           │
│  ┌───────────────────────────────────────────┐    ┌──────────────────┐    │
│  │              React 19 UI layer             │    │  Tauri commands  │    │
│  │  components/  Viewer · Toolbar · Sidebar    │◄──►│  file IO         │    │
│  │              Search · common                │ IPC│  recent files    │    │
│  │                     │                       │    │  native menus    │    │
│  │        theme/       │        a11y/          │    │  window state    │    │
│  │  ThemeProvider  data-theme  announcer/focus │    └──────────────────┘    │
│  │                     ▼                       │            ▲               │
│  │              commands/  Command registry    │            │ invoke()      │
│  │        (keyboard · palette · plugins · AI)  │            │               │
│  │           │                     │           │            │               │
│  │  plugins/ host + SDK      ai/ providers     │            │               │
│  │           │                     │           │            │               │
│  │           ▼                     ▼           │            │               │
│  │  state/  Zustand stores (single source)     │            │               │
│  │           │                                 │            │               │
│  │           ▼                                 │            │               │
│  │  core/  PdfEngine (interface)               │            │               │
│  │         PdfJsEngine (impl)                  │            │               │
│  └───────────┼─────────────────────────────────┘            │               │
│              │ postMessage                                   │               │
│              ▼                                               │               │
│  ┌───────────────────────────────┐                          │               │
│  │  PDF.js Web Worker             │   file bytes ────────────┘               │
│  │  parse · decode · text extract │                                          │
│  └───────────────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

Read the stack top-down as: **native shell → React UI → command registry → plugin host / AI layer → Zustand state → core PDF engine → PDF.js worker**, with the Rust backend attached over Tauri IPC for anything the WebView cannot do safely (file system, OS menus, persisted window state).

> Implementation status: the diagram is the intended shape. Today the Rust backend implements file IO (`read_document`, `write_document`), the browser hand-off (`fetch_pdf`), `app_version`, the default-viewer launch handling (`take_launch_file`, `open_default_apps_settings`), and the updater/deep-link plugins; native menus, recent files, and persisted window state are planned (see "Tauri command boundary"). Likewise the command palette shown under `commands/` is planned, not yet built. Reading the diagram, treat those cells as the roadmap, not current behavior.

## Module map

Each layer maps to a real directory in the repository.

| Layer | Directory | Responsibility |
|---|---|---|
| Rust backend | `src-tauri/src/` | Implemented: file read/write (`read_document`, `write_document`), browser hand-off (`fetch_pdf`), `app_version`, default-viewer launch handling (`take_launch_file`, `open_default_apps_settings`), plus the dialog, fs, updater, deep-link, single-instance, and process plugins. Planned: recent files, native menus, window state, secure store |
| Static assets | `public/` | Files served verbatim by Vite. Holds the self-hosted tesseract.js OCR runtime under `public/tesseract/` (git-ignored, populated by `scripts/setup-ocr-assets.mjs` via the `predev`/`prebuild` hooks); the PDF.js worker is bundled via a `?url` import, not placed here |
| UI components | `src/components/` | `Viewer/`, `Toolbar/`, `Sidebar/`, `Search/`, `common/` (`common/` also holds `toastStore` and the root `ErrorBoundary`) |
| Shared hooks | `src/hooks/` | `useNearViewport` (one shared `IntersectionObserver` per root/margin), `watchDevicePixelRatio`, `useMediaQuery` |
| Command registry | `src/commands/` | Every user action as a `Command`; single dispatch point |
| PDF core | `src/core/` | `pdf/` (`PdfEngine` interface + `PdfJsEngine`, plus `pageSizes` for lazily measured page geometry and `pageGeometry` for the mapping between the page as displayed and the unrotated user space pdf-lib draws into), `document/` (file picking and byte reading), `lru.ts` (capacity-bounded cache with a release hook) |
| State | `src/state/` | `documentStore` and `viewerStore`; other Zustand stores are colocated with their feature (theme, ai, annotations, plugins) |
| Theming | `src/theme/` | `ThemeProvider`, design tokens (`tokens.css`), `themeStore` (UI theme + dark scheme) |
| Accessibility | `src/a11y/` | Announcer (live region), focus trap, keyboard shortcut dispatch, skip link |
| Annotations | `src/features/annotations/` | Annotation model, `store` (localStorage sidecar), `bake` (embeds highlights/notes as real `/Highlight` and `/Text` annotations on save), and tools |
| Editing | `src/features/editing/` | Add text boxes, images, and check/cross mark stamps (typewriter tool + placement), per-document `store`, and pdf-lib baking (`stampEdits`) |
| Page operations | `src/features/pageops/` | Delete, reorder, and rotate pages: the declarative `PagePlan` and its pdf-lib application (`mutate`), the mark-and-sweep that takes a deleted page's content out of the file (`gc`), the selection and undo `store`, the shared page list used by both the thumbnail sidebar and the organizer, and the remapping that carries page-keyed sidecar state across a plan (`pageState`). See [page-operations.md](page-operations.md) |
| Click to place | `src/features/placement/` | The shared "click where it goes" mode used by add-text, add-image, add-check-mark, and signatures: a transient store holding the armed placement, the per-page click catcher, the hint banner (which also carries the keyboard path and the cancel affordances), and `rectAt` (anchor a rect at a point and keep it on the page) |
| Text editing (in place) | `src/features/textedit/` | Edit text already on a page: a content-stream tokenizer/interpreter that locates show-text operators (`contentStream.ts`), a pdf-lib splice-and-redraw step (`mutate.ts`), the click-to-edit overlay, and a transient (not persisted) undo stack in `store` |
| Image editing (in place) | `src/features/imageedit/` | Select, move, resize, replace, and delete an image XObject already on a page: reuses `features/textedit`'s content-stream tokenizer to locate `Do` operators, a pdf-lib rewrite step (`mutate.ts`) that edits or removes the operator in place, a locate cache, and the selection/resize overlay (`ImageEditLayer`) |
| OCR | `src/features/ocr/` | tesseract.js recognition (self-hosted, lazy-loaded), per-document `store`, selectable on-screen text layer, invisible baked layer (`stampOcrLayer`), and the search fallback |
| Signatures | `src/features/signatures/` | Visual signature creation (draw/type/upload), on-page placement, per-document `store`, and a small global list of recently typed names (`recents.ts`) |
| Digital signing | `src/features/signing/` | Certificate identities (create/import .p12 via node-forge), PKCS#7 signing (@signpdf), and signature detection. Runs in the WebView today; a Rust/keychain backend is planned |
| Combine | `src/features/combine/` | Merges two or more PDFs into one document via pdf-lib: pages, metadata, and (best-effort) AcroForm fields carried forward from the inputs. `store` holds the staged file list plus the progress and cancellation state for a merge in flight |
| Save / export | `src/features/export/` | Writes the filled PDF (PDF.js `saveDocument`), then loads pdf-lib once to bake the OCR layer, edits, signatures, and review annotations |
| Print | `src/features/print/` | Bakes via `exportDocument`, rasterizes the result in a throwaway PDF.js document at up to 144dpi (less on a long document, since every page bitmap has to be resident at once and the run is held to one memory budget; a document too long to fit even at the floor is refused), and hands `#folio-print-root` to `window.print()`. Each page image is capped on **both** axes so it fits inside one page box: sizing on width alone puts a page taller than the paper onto a second, near-blank sheet, which is one wasted sheet per page |
| Plugins | `src/plugins/` | Plugin host, SDK types, `contributionStore`, `builtins/` |
| AI layer | `src/ai/` | `aiStore`, `providers/` (`AIProvider` impls, Claude default), `mcp/` (experimental MCP transport) |

## Data flow: opening and rendering a PDF

The sequence below is the canonical path from a user gesture to pixels on screen.

```
User → Command "file.open"
  │
  ▼
dialog open()  (native picker via tauri-plugin-dialog; a hidden
  │             file input is the browser-dev fallback)
  │  returns a path
  ▼
Tauri command read_document(path)  → ArrayBuffer (bytes) back to the WebView
  │
  ▼
PdfEngine.loadDocument(source)   (source = { kind: 'bytes', data, name })
  │  hands bytes to PDF.js via getDocument()
  ▼
PDF.js Web Worker: parse structure, build cross-reference table, resolve fonts
  │  returns a document proxy (page count, metadata, outline)
  ▼
state/documentStore ← { info, metadata, outline }
  │
  ▼
Viewer requests visible pages → PdfEngine.renderPage(n, { scale, canvas })
  │  worker decodes page content → main thread paints to <canvas>
  ▼
PdfEngine.renderTextLayer(n, container, { scale }) → text layer overlaid on the canvas
  │
  ▼
a11y announcer: "Page 1 of 24"   (polite live region)
```

Key points:

1. **The WebView never touches the file system directly.** In the desktop app it asks the Rust `read_document` command for the bytes (the file picker itself is the dialog plugin). This keeps the security boundary explicit and lets Folio work with sandboxed WebView permissions. In a plain browser (`npm run dev` without Tauri) a hidden file input provides the bytes instead.
2. **`loadDocument(source)` accepts a `DocumentSource`, not a path.** The source carries either raw bytes (`{ kind: 'bytes', data, name }`) or a URL, so the engine is deliberately unaware of where the bytes came from, which keeps it portable and testable.
3. **Rendering is lazy and viewport-driven.** Only pages near the scroll position are rasterized. `viewerStore` tracks the current page and pending scroll target; the `Viewer` renders visible pages and recycles canvases as the user scrolls.
4. **The text layer is not optional.** Every rendered page gets a positioned text layer from `renderTextLayer` (backed by PDF.js text content; `getPageText` extracts the same text for search and AI), which is what makes selection, find-in-page highlighting, and screen-reader reading work against the real glyphs rather than a rasterized image.

## The PDF engine abstraction

Folio does not call PDF.js from the UI. All PDF access goes through a single interface in `src/core/pdf`:

```ts
interface PdfEngine {
  readonly isReady: boolean;
  loadDocument(source: DocumentSource): Promise<PdfDocumentInfo>;
  closeDocument(): Promise<void>;
  getPageDimensions(pageNumber: number, scale: number): Promise<PageDimensions>;
  renderPage(pageNumber: number, options: RenderPageOptions): Promise<void>;
  renderPageToImage(pageNumber: number, scale: number): Promise<PageImage>; // rasterize for OCR
  renderTextLayer(pageNumber: number, container: HTMLElement, options: RenderLayerOptions): Promise<void>;
  renderAnnotationLayer(pageNumber: number, container: HTMLElement, options: RenderLayerOptions): Promise<void>;
  getPageText(pageNumber: number): Promise<string>;
  getPageViewport(pageNumber: number, scale: number): Promise<PageViewport>;
  getTextItems(pageNumber: number): Promise<PageTextItems>;
  getOutline(): Promise<OutlineNode[]>;
  getMetadata(): Promise<PdfMetadata>;
  search(query: string, options?: { limit?: number }): Promise<SearchMatch[]>;
  hasFormFields(): Promise<boolean>;
  getPendingEditCount(): number;
  saveDocument(): Promise<Uint8Array>;
}
```

Page count is not a method: it comes back on the `PdfDocumentInfo` that `loadDocument` resolves to (`info.numPages`), which the stores hold.

`getPageViewport` and `getTextItems` are a deliberate exception to that narrowness: in-place text editing (`features/textedit`, see [editing-and-ocr.md](editing-and-ocr.md#editing-existing-text)) has to hit-test a click against the exact items and coordinate space PDF.js used to build the text layer, so the interface leaks PDF.js's `PageViewport` and per-item text content (`PageTextItems`) rather than re-wrapping them. `features/imageedit` reuses `getPageViewport` the same way, to convert a click and a drag between CSS pixels and PDF space, without needing `getTextItems`. No import of `pdfjs-dist` appears outside `core/pdf` even so: the two methods hand back PDF.js-shaped data rather than the module itself, and the barrel re-exports the `PageViewport` type so a caller can name what `getPageViewport` returns without reaching for PDF.js directly.

`PdfJsEngine` is the sole implementation today. It wraps `pdfjs-dist` v6: `loadDocument` calls `getDocument`, `renderPage` uses `page.render`, `renderTextLayer` and `getPageText` are built from `page.getTextContent`, and so on.

Two rules of the rendering contract are easy to break by accident, and both show up as garbled pages rather than as errors:

- **A page is drawn by three renders that must agree, and any of them can be superseded.** `renderPage`, `renderTextLayer` and `renderAnnotationLayer` all take an `AbortSignal` (`RenderPageOptions` / `RenderLayerOptions`), and the caller re-checks staleness between them. The layer renders are also serialised per container inside the engine, because PDF.js builds a layer by appending across `await` points: two overlapping passes on one element interleave, and the older pass's leftovers survive the newer one's `replaceChildren()` as duplicated elements. Pass the signal through; do not render a layer into an element another pass may still own.
- **Form widgets are drawn exactly once, by whoever owns them.** `renderPage({ overlayForms: true })` tells the engine that the caller will overlay real DOM inputs, so the widgets are left out of the raster (`annotationMode: ENABLE_FORMS`, which is the only mode that suppresses them; `ENABLE_STORAGE` sets a different intent flag and paints them anyway). Callers that rasterise a page on its own, like thumbnails, leave the flag unset and get the values painted in. Setting it without an annotation layer loses the values; omitting it under one doubles them.

### The per-page overlay stack

Every page is a `.folio-page` box holding the canvas plus a stack of absolutely
positioned overlays, rendered by `components/Viewer/Page.tsx`. The order is
load-bearing and is set by `z-index` in `styles/global.css`, not by DOM order:

| z | Layer | What it is |
| --- | --- | --- |
| 0 | `.folio-page-canvas` | The rasterized page |
| 1 | `.folio-annotation-layer` | PDF.js annotations (links, existing markup) |
| 2 | `.folio-text-layer` | The real text layer: selection, find, screen readers |
| 3 | `.folio-forms-layer` | PDF.js AcroForm widgets, as native inputs |
| 3 | `.folio-ocr-layer` | Selectable OCR text, when a page has been recognised |
| 4 | `.folio-signature-layer`, `.folio-notes-layer` | Placed signatures, sticky-note pins |
| 5 | `.folio-edit-layer` | Placed text boxes, images, and check marks |
| 6 | `.folio-textedit-layer` | In-place editing of existing PDF text; holds its own `.folio-textedit-hit` catcher |
| 7 | `.folio-textedit-editor` | An open in-place editor, above that tool's catcher |
| 8 | `.folio-placement-hit`, `.folio-imageedit-layer` | The other two armed click-catchers |

**The rule that is easy to break: a full-page click-catcher sits above the forms
layer.** `.folio-forms-layer` only takes pointer events over each field's own
small rect, so the rest of a page falls through to whatever is under it. But a
tool that covers the whole page at a higher z-index takes *everything*, including
the clicks meant for a checkbox or a text field. Three tools do this — in-place
text editing, image selection, and any armed placement — and all three would
otherwise make forms unfillable while switched on.

The fix is one shared hit-test, `state/formsLayer.ts`, which each catcher calls
before acting: `formWidgetAt(x, y)` walks `document.elementsFromPoint` for the
topmost interactive widget inside `.folio-forms-layer`, and the catcher replays
the click on it and returns. What "acting" means differs per tool, and one of
them inverts the rule deliberately: the check-mark tool *yields* to a real widget
rather than stamping over it, because a mark exists only to stand in for a
printed box that has no field behind it. That is why `PendingPlacement` carries
an opt-in `deferToFormWidget` rather than the behaviour being unconditional.

If you add a tool that covers the page, call `formWidgetAt` first. Note that the
three catchers do not share one z-index: text editing sits at 6 so that its own
open editor (7) stays above it, while placement and image selection sit at 8.
Pick a new tool's z deliberately against the table above rather than copying 8,
which would put a fresh catcher over an open in-place editor.

### Rendering resolution, virtualization, and DPI changes

Three things beyond the render contract itself keep pages sharp and memory bounded on long documents, all in `src/core/pdf/PdfJsEngine.ts` and `src/components/Viewer/Page.tsx`:

- **Supersampled, budget-capped canvases.** Each page's backing store is rendered above the display's own density so text stays crisp on fractional DPI (Windows 125%/150% scaling gives a `devicePixelRatio` of 1.25/1.5) and on platforms that under-report DPI. `outputScale` targets the greater of 2x and the display's own `devicePixelRatio` -- there is no upper ceiling of its own, so a 4x panel gets a 4x store rather than a 3x one it would have to stretch -- but is capped by a pixel budget, `MAX_CANVAS_AREA` (2^24, matching PDF.js's own `maxCanvasPixels` default) and `MAX_CANVAS_DIM` (4096px per side). The caps win unconditionally, so at high zoom on large pages the effective scale can fall below the display's `devicePixelRatio` and the browser upsamples instead. The CSS size stays the page's layout size; the larger backing store is downsampled into it.
- **Page virtualization.** Every page keeps a lightweight `<div>` in the DOM; what is windowed is the expensive part, not the element. This is the model PDF.js's own viewer uses, and it is why Folio has no virtual-list dependency: an empty page box costs a DOM node, while a canvas costs megabytes. `Page.tsx` watches each page against two rings, both served by `useNearViewport` (`src/hooks/`):
  - **600px, the raster ring.** Inside it a page rasterizes; leaving it releases the canvas backing store (dimensions set to 0, text and annotation layers cleared) and it re-renders on the way back in. Without this, every page a user had ever scrolled past kept its full-resolution canvas allocated for the life of the session. A page is held out of this ring until its size is known, because a page with no size is 0px tall and, in the window before the first measurement lands, every page in the document would sit inside the ring at once.
  - **2400px, the wide ring.** Gates real measurement and the eight per-page overlay layers. Those layers each subscribe to a feature store and filter to their own page, so mounting them for every page made any single edit O(pages x items). The ring is deliberately much wider than the raster one so a layer is in place well before its page is painted, and it always contains the current page, which two of the layers key their click-catchers off. One exception overrides the ring: a page holding live editing state (a focused or selected text edit, or an open in-place text session) keeps its overlays mounted wherever it is. Wheel and keyboard scrolling never blur, and no browser fires blur when the focused node is removed, so unmounting under a caret would silently discard whatever had not been committed yet.

  Both rings name the scroller (`.folio-viewer`) as their root, and this is load-bearing rather than tidiness. `rootMargin` only grows the root's own rect, and an element root is still intersected with every clipping ancestor between it and the target, unexpanded. Left at the implicit viewport root, the scroller's overflow clips both rings away and a page below the fold reads as outside both at once, so the wide ring stops being wider than the narrow one. The same mistake in the thumbnail sidebar (rooted at the unclipped inner column instead of `.folio-sidebar__body`) reported every thumbnail in the document as visible in the first batch.

  `useNearViewport` shares one `IntersectionObserver` per (root, margin) pair across every page rather than constructing one each: a 2000-page document was allocating 2000 observers to answer a question one observer with 2000 targets answers, and delivering their callbacks unbatched.
- **Page sizes are measured once, at scale 1** (`src/core/pdf/pageSizes.ts`). A page's size at any zoom is its intrinsic size times the scale, so one measurement serves every zoom level; measuring at the current scale instead meant re-measuring the entire document on every zoom step. Until a page is measured it lays out at a document-wide estimate taken from page 1 (which `PdfViewer` already fetches for fit), so the scrollbar is honest from the first frame without touching the whole document, and a uniform document -- almost all of them -- never notices the estimate was one. The cost is that a jump deep into a long document aims at estimated positions; `PdfViewer` re-aims the smooth scroll when an arriving measurement moves the target.
- **Bounded engine caches.** `PdfJsEngine`'s page, text, and text-item caches are LRUs (`src/core/lru.ts`), not unbounded maps cleared only on close. Eviction of a page **must** call `PDFPageProxy.cleanup()`: PDF.js memoizes every page it hands out in its own `WorkerTransport` cache for the life of the document, so dropping our reference frees nothing by itself. `cleanup()` releases the cached operator list and the page's decoded images and fonts, leaves the proxy usable (the next render refetches), and is a no-op while a render is in flight.
- **Re-render on DPI change.** Dragging the window between monitors with different scale factors changes `devicePixelRatio` without a resize event. `PdfViewer` delegates to `watchDevicePixelRatio` (`src/hooks/`), which brackets the current ratio with a `(min-resolution: X)` and `(max-resolution: Y)` range query and re-registers each time it fires, bumping a `renderNonce` in `viewerStore`; pages depend on that nonce and re-rasterize at the new resolution. The range matters: an exact `(resolution: Xdppx)` query built by interpolating a fractional ratio (Windows at 133% reports 1.3333333333333333) may never evaluate true, and a query that starts false never flips -- so the feature would silently do nothing on precisely the fractional-scaling displays it exists for. If even the range query fails to match, a low-frequency poll is armed as a backstop rather than trusting it a second time.

### Why PDF.js, and why the interface

- **Why PDF.js:** it is mature, MIT-licensed, actively maintained, renders to `<canvas>`, and already produces a positioned text layer that we need for accessibility. It runs in the WebView with no native rendering dependency, which keeps the desktop bundle simple.
- **Why abstract it:** PDF.js is a JavaScript renderer. For very large documents or heavy print production, a native rasterizer such as **PDFium** can be faster and more precise. By routing everything through `PdfEngine`, a future `PdfiumEngine` (likely a Tauri command backed by a Rust PDFium binding) can be swapped in without touching the UI, the command registry, or the stores. The interface is the seam.

Nothing above `src/core/pdf` imports `pdfjs-dist`, values or types alike. If you see a `pdfjs-dist` import outside `core/pdf`, that is a layering violation; add the type to the barrel's re-exports instead.

**There is currently one violation, and it cost a shipped-broken feature.** `src/features/print/printDocument.ts` calls `getDocument()` directly, because it rasterizes a *throwaway* document (the baked export bytes) rather than the open one, and `PdfEngine` models the open document. It imported `pdfjs-dist` while the rest of the app imports `pdfjs-dist/legacy/build/pdf.mjs`, so `ensureWorker()` configured one module's globals and print called the other, unconfigured, copy: every print failed on `No "GlobalWorkerOptions.workerSrc" specified`. Until print is routed through the barrel, anything opening its own document owes two things `PdfJsEngine` would have supplied:

- the **legacy build** for values (see below), and
- `wasmUrl: pdfWasmUrl()` on `getDocument()`, without which the worker has no JBIG2 or JPEG2000 decoders and scanned pages come out blank.

Note that unit tests cannot enforce this. `vi.mock('pdfjs-dist')` will happily stand in for a module the app should never have imported, which is exactly how the above passed 20 green tests. `e2e/print.spec.ts` runs the real PDF.js and is what actually guards it.

## PDF.js Web Worker threading model

PDF.js splits work across two threads:

- **Main thread (UI):** owns the DOM, canvases, and React. It sends commands (load, render, get text) and receives results.
- **Worker thread:** does the CPU-heavy work: parsing the file structure, decoding streams, resolving and rasterizing fonts, and extracting text content.

`setupWorker.ts` sets `GlobalWorkerOptions.workerSrc` (once, idempotently) to a hashed worker URL that Vite emits from a `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` import, so the worker travels with the bundle rather than being copied into `public/`. Communication is `postMessage`-based and structured-clone friendly, so page bitmaps and text runs cross the boundary without blocking input handling.

**Both PDF.js imports are from `legacy/build`, and they have to stay there.** The default v6 bundle assumes a 2025-era engine: it reads `Iterator.prototype` at module scope (a `ReferenceError`, not a feature test, on engines without iterator helpers) and calls `Map.prototype.getOrInsertComputed` on the annotation-layer render path. Folio's Linux target is webkit2gtk-4.1, whose WebKitGTK on the Ubuntu LTS releases CI builds against predates both. The legacy bundle ships the core-js polyfills, at roughly +58 KB minified on the main bundle and +50 KB on the worker.

Two consequences that are easy to get wrong:

- **The API and the worker must be the same build.** The worker refuses to talk to an API of a different version.
- **`GlobalWorkerOptions` is per module instance.** Importing bare `pdfjs-dist` anywhere for *values* gives you a second copy of PDF.js whose worker was never configured, and the failure surfaces at the first `getDocument()` rather than at the import. Types are safe to take from the package root — `legacy/build/pdf.d.mts` is a bare re-export of them — which is why `PdfJsEngine.ts` imports values from `legacy/build` and types from `pdfjs-dist`.

Practical consequences:

- Scrolling stays smooth even while a large page decodes, because decode happens in the worker.
- A single worker is shared per document. Render requests are queued; the `Viewer` cancels off-screen render tasks (`RenderTask.cancel()`) when the user scrolls away, so the worker is not wasted on pages that are no longer visible.
- Worker configuration is the most common setup pitfall. See `getting-started.md` (troubleshooting) if pages fail to render with a "worker not loading" style error.

## Failure handling in the UI

`main.tsx` wraps the app in an `ErrorBoundary` (`src/components/common/`). Without one, React unmounts the entire root fiber tree when any component throws during render, and since `index.html`'s body holds nothing but `<div id="root">`, the result is a blank window: no toolbar, no message, nothing to report. The boundary turns that into something the user can act on and an operator can diagnose (the component stack goes to the console; `error.stack` alone rarely says which page or layer failed).

Know what it does **not** catch, because the gap is where the hard bugs live:

- Throws from event handlers, async callbacks, and timers. Those are handled where they happen -- the open path in `state/actions.ts` catches and surfaces an error state, and render failures are logged per page.
- A renderer process killed by the OS for running out of memory. There is no JS exception to catch; the window simply goes white and stays that way. That failure mode is addressed by bounding allocation (see [Rendering resolution, virtualization, and DPI changes](#rendering-resolution-virtualization-and-dpi-changes)), not by error handling.

## State management (Zustand)

State is the single source of truth between the UI, commands, plugins, and the AI layer. Stores are small, focused Zustand slices rather than one monolith. Two live in `src/state/`; the rest are colocated with the feature they serve, so a store sits next to the code that owns it.

| Store | File | Holds | Written by |
|---|---|---|---|
| `documentStore` | `src/state/documentStore.ts` | Load status, document `info`, metadata, outline, error, a `docVersion` counter bumped on each in-place text or image edit | `loadSource`/`closeDocument` actions, `reloadEditedBytes` |
| `viewerStore` | `src/state/viewerStore.ts` | Scale, fit mode (custom/width/page), current page, page count, sidebar open + active tab, search open, pending scroll target | Zoom/nav/sidebar commands, scroll handler |
| `themeStore` | `src/theme/themeStore.ts` | UI theme (light/dark/system), resolved theme, dark page scheme (night/green/amber) | Theme commands, system preference listener |
| `aiStore` | `src/ai/aiStore.ts` | AI enabled flag, selected provider id (disabled by default) | AI settings UI |
| annotation store (`useAnnotationStore`) | `src/features/annotations/store.ts` | Current document fingerprint and its annotations | `features/annotations/` tools |
| contribution store (`useContributionStore`) | `src/plugins/contributionStore.ts` | Plugin-contributed toolbar items, sidebar panels, annotation tools | Plugin host on activate/deactivate |
| `toastStore` | `src/components/common/toastStore.ts` | Transient toast notifications | `pushToast` (commands, plugins) |

Those are the core stores; the editing, OCR, signatures, signing, text-edit, image-edit, placement, and context-menu features colocate their own stores the same way (`src/features/*/store.ts`). There is no separate `viewportStore` or `uiStore`: view and UI state (zoom, fit, sidebar, search) all live in `viewerStore`. There is no `pluginStore`; plugin UI contributions live in `contributionStore`.

Design rules:

- **Commands and actions mutate state; components read it.** A React component should not orchestrate a workflow directly. It dispatches a command (or calls a state action); that updates the relevant store; components re-render from the store.
- **Stores never import from `components/`.** Data flows down, actions flow up through commands.
- **Persistence is selective.** UI theme and dark scheme are persisted in local storage (`themeStore`), and annotations are persisted per document fingerprint in local storage (`features/annotations/store.ts`). Transient view state such as scroll position is not. A recent-files list persisted via the Rust backend is planned, not yet implemented.

## Extension points

Folio is designed to be extended without forking. The stable surfaces are:

1. **Commands (`src/commands`).** The primary extension point. Anything a user can do is a `Command`:

   ```ts
   interface Command {
     id: string;
     title: string;
     category?: string;
     keybinding?: string;
     when?: () => boolean;
     run(ctx?: CommandContext): void | Promise<void>;
   }
   ```

   Keyboard shortcuts, the future command palette, plugins, and AI actions all dispatch through the same registry. `when` gates availability (for example, "a document is open"); `keybinding` wires a shortcut; `category` groups entries in the palette.

2. **Plugins (`src/plugins`).** A plugin is a module that receives the SDK and registers contributions: commands, sidebar panels, toolbar items, and annotation-tool additions. Built-ins in `plugins/builtins/` are written against the same SDK a third party would use, which keeps the SDK honest.

3. **Viewer regions.** The `Toolbar`, `Sidebar`, and overlay layers expose named slots that plugins can contribute React nodes into, so extensions surface UI without patching core components.

4. **AI providers (`src/ai/providers`).** New providers implement the `AIProvider` interface. Claude/Anthropic is the default. The UI and commands talk to the interface, never to a specific vendor SDK, so swapping or adding a provider is a registration, not a rewrite. `src/ai/mcp/` holds an experimental Model Context Protocol client and server (`McpClient`, `McpServer`); AI is disabled by default, so nothing is sent anywhere until the user turns it on.

5. **Theme tokens (`src/theme`).** Plugins consume CSS custom properties (for example `--folio-surface`, `--folio-text`, `--folio-accent`) rather than hard-coded colors, so their UI follows the active theme automatically. See `theming.md`.

6. **PDF engine (`src/core/pdf`).** Not a public plugin surface, but the same seam: implementing `PdfEngine` swaps the rendering backend.

## Tauri command boundary

The Rust backend in `src-tauri/src/` exists to do what a WebView should not do itself. It is intentionally thin: it owns native capabilities and exposes them as Tauri commands the frontend calls via `invoke()`.

Implemented today (`src-tauri/src/lib.rs`), the registered commands are:

- **`read_document(path)`.** Read a PDF from disk and return its raw bytes to the frontend. It returns a Tauri `Response` (a binary body the frontend receives as an `ArrayBuffer`) rather than a JSON array, so a multi-megabyte PDF is not serialized number-by-number. It rejects paths that do not end in `.pdf`. The frontend receives bytes, never raw file-system access.
- **`write_document`.** Write the exported PDF to disk: Save-in-place hands it the opened file's own path, Save-a-copy the path the user chose in the native save dialog. The write is atomic (a randomly named temp file in the destination directory, renamed over the target), so a crash or full disk mid-write never leaves a truncated PDF where the user's document was. Living on the Rust side (it mirrors `read_document`) means the frontend needs **no** broad filesystem capability; the previous `fs:allow-write-file` (`$HOME/**`) scope was removed. Rejects non-`.pdf` paths. The bytes arrive as the **whole invoke payload**, which Tauri ships as a raw binary body: this is the write-direction mirror of `read_document` returning a `Response`, and passing them as a field of an arguments object instead would expand them into a JSON array of numbers. A raw body cannot carry a sibling named argument, so the destination path travels in a `Folio-Path` header, percent-encoded (header values are ASCII only, and encoding also removes any CR/LF injection surface). The command accepts a JSON body too, so the `postMessage` fallback still saves if the IPC custom protocol is ever unavailable. That protocol needs `ipc: http://ipc.localhost` in the CSP `connect-src`; without it the fast path silently degrades.
- **`fetch_pdf(url)`.** Download a PDF handed off from the browser extension's `folio://` deep link. Because any web page can trigger the link, the input is treated as hostile: the scheme must be http/https, then the host is resolved and **every** resolved IP is checked against a private/reserved-range blocklist (loopback, RFC 1918, link-local incl. the `169.254.169.254` metadata endpoint, CGNAT, benchmarking, reserved, multicast, and the IPv6 equivalents incl. IPv4-mapped forms). Validating resolved IPs rather than the URL string defeats decimal/hex/octal IP encodings and DNS names pointing at private space. The download agent is then pinned to those pre-validated IPs (closing the DNS-rebinding window between the check and the connect), follows no redirects (so a public URL cannot 3xx-bounce to an internal host), enforces connect/read timeouts, and caps the response size. Cookie-gated PDFs are out of scope here (no browser session); the extension's in-browser viewer covers those.
- **`app_version()`.** Return the running version string, sourced from `Cargo.toml`.
- **`take_launch_file()`.** Return (and clear) the PDF path Folio was launched with as the default `.pdf` handler. The path is captured from the process arguments at startup, validated (must end in `.pdf` and exist on disk), and consumed exactly once by the frontend on mount, so an in-app reload does not silently re-open it.
- **`open_default_apps_settings()`.** Open the OS "Default apps" settings so the user can make Folio the default PDF viewer. Windows launches the fixed `ms-settings:defaultapps?registeredAppUser=Folio` URI (deep-linked to Folio's page; no user input is interpolated) through ShellExecute via a hidden `cmd /C start`, because handing the URI to `explorer.exe` drops the query on some Windows builds and falls through to the default browser. Modern Windows does not permit an app to seize a default handler silently, so this is a guided deep link rather than a silent switch.

The native open and save pickers are provided by `tauri-plugin-dialog`; the document is prepared for saving in the frontend (PDF.js `saveDocument()` writes filled form values, then pdf-lib is loaded once to bake the invisible OCR text layer, placed edits, signatures, and review annotations in that order; see `src/features/export/`) and the bytes are written by `write_document`. In-place text and image edits (`src/features/textedit/`, `src/features/imageedit/`) bypass that bake step: each commit already spliced or rewrote the target operator in the page's content stream and reloaded the engine from the result at edit time, so by the time a save runs, those edits are already part of the bytes `saveDocument()` returns. Also registered in `run()`: `tauri-plugin-fs` (no broad scopes granted; file IO goes through the commands above), `tauri-plugin-updater` (in-app updates, desktop only), `tauri-plugin-deep-link` + `tauri-plugin-single-instance` (the `folio://` scheme and single-window URL routing), and `tauri-plugin-process` (relaunch after an update). See `docs/releasing.md` for the signing and update-manifest flow.

Opening a PDF as the **default viewer** has two entry points, handled in `src/features/fileopen/`. On a cold start the OS launches Folio with the file path in `argv`; `run()` captures it and the frontend pulls it via `take_launch_file`. When Folio is already running, a second launch is intercepted by `tauri-plugin-single-instance`, which forwards the path to the existing window as a `folio:open-pdf` event (macOS delivers the file as an `Opened` run event instead of argv; that branch is wired but untested).

The `.pdf` association itself is registered by the installer, in two halves. `bundle.fileAssociations` in `tauri.conf.json` produces the ProgID (`PDF Document`) and unconditionally overwrites `Software\Classes\.pdf`'s default value to point at it. On a machine where `UserChoice` (see below) is already set, that write is masked and just makes Folio able to *handle* a PDF without yet being *offered* one. `UserChoice` is not guaranteed to exist, though: on a fresh image, a server SKU, or any machine where the user never made an explicit choice, that plain `Software\Classes\.pdf` write is the live default, so installing Folio there does take `.pdf` over. The hooks in `src-tauri/installer.nsh` add the rest of what Explorer's "Open with" list is actually built from: `Software\Classes\.pdf\OpenWithProgids`, a `Software\Classes\Applications\folio.exe` entry with `FriendlyAppName` and `SupportedTypes`, an `Application` subkey so the picker labels the entry *Folio* rather than the ProgID's file-type description, and the `RegisteredApplications` capabilities key that `open_default_apps_settings` deep-links into. None of those four are ever consulted ahead of `UserChoice`. Once `UserChoice` exists it is hash-protected, so only Explorer can write it, and every `ShellExecute` hand-off (double-click, Chrome's "open downloaded file") follows it first. Past that point the installer's job is only to make Folio *choosable*; choosing stays the user's.

Planned Rust-side responsibilities (documented in the `lib.rs` module comment, not yet built):

- **Recent files.** Maintain and persist the recent-documents list across sessions, and feed it to the native menu and the UI.
- **Native menus.** Build the OS application/menu bar (File, View, Help, and so on) and forward menu clicks to frontend commands so a menu item and a keyboard shortcut run the exact same `Command`.
- **Window state.** Persist and restore window size, position, and maximized state so Folio reopens the way the user left it.
- **Secure store.** Hold AI provider credentials in OS-native secure storage.

Everything else, including all PDF parsing, rendering, text extraction, search, theming, and annotation logic, lives in the frontend/TypeScript layer. This keeps the Rust surface small, auditable, and stable, and it keeps the door open for the future native-rasterizer backend to be added as additional commands without disturbing the rest of the app.

## Security

- **Content Security Policy.** The desktop shell defines a strict `app.security.csp` (`src-tauri/tauri.conf.json`): `default-src 'self'` with narrowly scoped `script`/`style`/`img`/`font`/`connect`/`worker` sources, `object-src 'none'`, and `base-uri 'self'`. It permits the bundled assets, the PDF.js worker (`worker-src 'self' blob:`) and its wasm image codecs (`'wasm-unsafe-eval'`), plus the opt-in Anthropic API (`connect-src https://api.anthropic.com`); no other remote origins are allowed. `frame-ancestors 'none'` and `form-action 'none'` close the framing and form-submission vectors.
- **VS Code extension.** The [VS Code extension](../extensions/vscode/README.md) renders in a webview under a strict, nonce-locked CSP (`default-src 'none'`, `script-src 'nonce-…'`). Attacker-controlled input (an opened PDF's filename) reaches the webview HTML only through `escapeHtml` or `asWebviewUri` encoding; both paths are fuzzed (see `extensions/vscode/fuzz/`).
- **Chrome extension.** The [Chrome extension](../extensions/chrome/README.md) runs under an MV3 extension CSP (`script-src 'self' 'wasm-unsafe-eval'`). It either hands PDFs to the desktop app via `folio://` or renders them in Folio's bundled viewer; the desktop side validates the handed-off URL in `fetch_pdf`. Two things carry the weight on the browser side. The viewer is reached by a `declarativeNetRequest` redirect that puts the document's URL in the fragment, so **that URL is untrusted**: any page can navigate to the viewer and choose it, and `openFromQueryParam` scheme-checks it (http/https only) before it reaches `fetch`. And `web_accessible_resources` exposes only `dist/index.html`, the entry point a cross-origin navigation actually needs; the page's own assets are same-origin once it has loaded, so nothing else has to be reachable from the web. The permission surface is pinned by `scripts/check-extension-manifest.mjs` and enforced in CI, so widening it is a deliberate edit rather than a side effect. One consequence is worth stating plainly rather than leaving to be discovered: an extension `fetch` carries credentials for the target host, so a page that navigates the user to the viewer with a fragment of its choosing causes an **authenticated cross-origin GET** to that URL. It is bounded rather than eliminated -- the attacker cannot read the response (the navigation hands the tab to the extension origin), and a plain link would send the same cookies anyway -- but `frame-ancestors 'none'` is what closes the materially worse variant, where a page frames the viewer, stays in control, and uses load success or failure as an oracle.
- **Native boundary.** File IO is confined to Rust commands: `read_document` and `write_document` reject non-`.pdf` paths, there is no broad frontend filesystem capability, and `fetch_pdf` validates the resolved IPs of the handed-off URL, pins the connection to them, and refuses redirects to block SSRF against local/private/metadata endpoints (see the Tauri command boundary above).

## Related documents

- `docs/accessibility.md`: keyboard model, ARIA landmarks, live-region announcements, WCAG 2.2 AA mapping.
- `docs/theming.md`: design tokens, light/dark, and dark schemes.
- `docs/getting-started.md`: environment setup and development workflow.
- `docs/adr/`: architecture decision records for the choices summarized here.
