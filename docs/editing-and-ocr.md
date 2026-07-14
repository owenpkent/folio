# Editing and OCR

Folio can add content to a page and recognize text in scans, then save a copy
with everything baked in. This page explains how both work today and what is
deliberately out of scope.

Two capabilities, both additive to the page:

1. **Editing.** Add **text boxes** (a typewriter tool) and place **images**
   (PNG/JPEG). You can drag, resize, and edit them; they are burned into the PDF
   only when you save a copy.
2. **OCR.** Recognize text in **scanned / image-only** pages with a bundled,
   offline English engine. The result is selectable on screen, searchable in-app,
   and baked into the saved PDF as an invisible text layer.

> Scope, up front: Folio does **not** edit glyphs already in the PDF, reflow
> paragraphs, or replace embedded images. These are additive overlays. Editing
> existing content, page operations, redaction, and non-Latin OCR are on the
> [roadmap](../ROADMAP.md), not built.

## Editing: text boxes and images

### Using it

- **Add text:** toolbar *Add text box* (the `T` icon) drops an empty box on the
  current page and focuses it. Type directly. While a box is selected an inline
  inspector offers font (Sans / Serif / Mono), size, **bold**, and color. Drag
  the top grip to move it, the corner to resize. Click empty space or press
  Escape to deselect.
- **Add image:** toolbar *Add image* opens a PNG/JPEG picker; the image is placed
  centered, preserving its aspect ratio, and can be dragged and resized.
- **Save:** *Save a copy* (`Ctrl/Cmd + S`) writes a new PDF with the edits baked
  in. The original file is never modified.

### How it works

Edits are stored as a per-document sidecar (keyed by PDF fingerprint) in
`localStorage`, exactly like annotations and signatures. Each item is a
`NormalizedRect` (fractions 0..1 of the page, top-left origin) so it survives
zoom, plus its content:

```ts
type EditItem =
  | { kind: 'text'; rect; text; fontFamily; bold; fontSizePt; colorHex; ... }
  | { kind: 'image'; rect; dataUrl; mime; ... };
```

- **On screen:** `EditLayer` (in `src/features/editing/`) renders each item over
  the page. Text font size is `fontSizePt * scale` so it tracks zoom; images fill
  their rect.
- **On save:** `stampEdits` (`src/features/editing/bake.ts`) loads the PDF with
  pdf-lib and draws each item. Normalized rects are top-left origin, PDF space is
  bottom-left, so the y-axis is flipped: `y = pageHeight - rect.y*pageHeight - h`.
  Text uses a `StandardFont` (`drawText` with manual word-wrap to the box width);
  images use `embedPng` / `embedJpg` + `drawImage`.

### Limitations

- **Fonts are Latin (WinAnsi).** The standard PDF fonts (Helvetica, Times,
  Courier and their bold variants) cover Latin text. Characters they cannot
  encode are not drawn. Custom/Unicode fonts need `@pdf-lib/fontkit`, which is
  not wired up.
- **Wrapping is best-effort.** The baked line breaks approximate the browser's
  CSS wrapping; they will not be pixel-identical.

## OCR: making scans searchable

### Using it

Use a scanned or image-only PDF (one with no embedded text).

- Toolbar *Recognize text (OCR)* (the scan icon) recognizes the whole document; a
  progress modal counts pages and can be cancelled. There is also a
  `ocr.recognizePage` command for the current page only.
- Afterwards the recognized text is **selectable** on the page (select and copy),
  and **find** (`Ctrl/Cmd + F`) searches it.
- *Save a copy* bakes an invisible text layer over the image, so the exported PDF
  is searchable and copyable in any reader.

Results persist per document (fingerprint), so re-opening a recognized PDF does
not re-run OCR.

### How it works

- **Engine:** [tesseract.js](https://github.com/naptha/tesseract.js) (English,
  LSTM). It is **lazy-loaded** (dynamic `import`) so it stays out of the initial
  bundle, and the first recognition creates a single reused worker.
- **Rasterize:** `PdfEngine.renderPageToImage(pageNumber, scale)` renders a page
  to a PNG at 2x (no HiDPI multiplier, for a predictable pixel grid). tesseract
  returns words with pixel bounding boxes, which are normalized to the page.
- **On screen:** `OcrTextLayer` renders transparent, selectable spans at each
  word's rect (font size derived from the layer's measured height).
- **On save:** `stampOcrLayer` (`src/features/ocr/bake.ts`) draws each word with
  `drawText(..., { opacity: 0 })` — present for search/copy, invisible on the
  page. Words the standard font cannot encode are skipped individually.
- **Search fallback:** `searchWithOcr` runs the engine's embedded-text search and,
  for recognized pages with no embedded match, adds hits from the OCR text — so
  scans are searchable in-app without changing the engine.

### Self-hosted, offline, CSP-safe

The app's Content Security Policy forbids loading code or data from a CDN, and
the desktop app must work offline, so the entire OCR runtime is self-hosted:

- The worker script, the SIMD-LSTM wasm core, and the English model
  (`eng.traineddata.gz`) live under `public/tesseract/` and are served from the
  app's own origin (`/tesseract/...`). The CSP already permits this:
  `script-src 'wasm-unsafe-eval'`, `worker-src 'self'`, `connect-src 'self'`.
- Those files are large and derived, so they are **git-ignored** and populated by
  [`scripts/setup-ocr-assets.mjs`](../scripts/setup-ocr-assets.mjs), which copies
  the worker/core from the pinned `tesseract.js` / `tesseract.js-core` packages
  and downloads the model once from the tesseract.js maintainers' data host. The
  `predev` / `prebuild` npm hooks run it automatically; run it by hand with
  `npm run setup:ocr`. See [getting-started](getting-started.md#ocr-assets).

A `.js` `corePath` is passed to tesseract.js, which pins the SIMD-LSTM core and
skips its runtime SIMD auto-detection. Baseline wasm SIMD is supported by
WebView2 and modern browsers, Folio's only targets.

### Limitations

- **English only** for now. Other languages need their own `traineddata` and, for
  non-Latin scripts, a Unicode font for the baked layer (`@pdf-lib/fontkit`).
- **Alignment is approximate.** The invisible layer is positioned per word box,
  which is more than enough for search and copy but is not a pixel-perfect glyph
  overlay.

## Where the code lives

| Piece | Path |
| --- | --- |
| Editing store, overlay, commands | `src/features/editing/` |
| Editing bake (pdf-lib) | `src/features/editing/bake.ts` |
| OCR recognition + worker | `src/features/ocr/recognize.ts` |
| OCR store, text layer, modal, commands | `src/features/ocr/` |
| OCR bake (invisible layer) | `src/features/ocr/bake.ts` |
| Search fallback | `src/features/ocr/search.ts` |
| Page rasterize | `src/core/pdf/PdfJsEngine.ts` (`renderPageToImage`) |
| Export pipeline (loads pdf-lib once) | `src/features/export/saveDocument.ts` |
| Self-hosted OCR assets | `scripts/setup-ocr-assets.mjs`, `public/tesseract/` |

Manual test steps are in [testing.md](testing.md#editing-text-boxes--images).
