# Editing and OCR

Folio can add content to a page, edit text and images that are already on it,
and recognize text in scans, then save a copy with everything baked in. This
page explains how each capability works today and what is deliberately out of
scope.

Four capabilities:

1. **Editing.** Add **text boxes** (a typewriter tool), place **images**
   (PNG/JPEG), and stamp **check marks** (for ticking a printed checkbox that has
   no real form field behind it, Acrobat Fill & Sign-style). You can drag,
   resize, and edit them; they are additive overlays, burned into the PDF only
   when you save a copy. The underlying page content is never touched.
2. **Editing existing text.** Click text already on the page and replace it in
   place: the original show-text operator is removed from the page's content
   stream, and the replacement is drawn at the same spot, rather than covered
   up. Unlike the tool above, this changes the open document as soon as you
   commit an edit, not only when you save.
3. **Editing embedded images.** Select an image already drawn on the page, then
   move it, resize it, or replace it with a different PNG/JPEG. Like the tool
   above, this changes the open document as soon as you commit an edit.
4. **OCR.** Recognize text in **scanned / image-only** pages with a bundled,
   offline English engine. The result is selectable on screen, searchable in-app,
   and baked into the saved PDF as an invisible text layer.

> Scope, up front: in-place text edits replace one run at a time with a
> substituted standard font, not the document's own embedded font, and do not
> reflow a paragraph. Rotated or skewed text, runs that share positioning with
> a neighbor, text in a Form XObject the page draws more than once, and
> characters the standard fonts cannot encode are refused rather than risking
> a corrupt file. Embedded images can be moved, resized, and replaced the same
> way, except a rotated or skewed image can only be replaced (moving or
> resizing it is refused), and an image inside a Form XObject is not editable
> yet at all. Page operations, redaction, and non-Latin text remain on the
> [roadmap](../ROADMAP.md).

## Editing: text boxes, images, and check marks

> Real AcroForm checkbox and radio widgets are not part of this section: PDF.js's
> own annotation layer already renders and toggles them (see
> [forms-and-signatures.md](forms-and-signatures.md)). The **Add check mark**
> tool below is only for the common case a real widget cannot cover: a printed
> square with no form field behind it at all (a flattened or scanned form),
> where there is otherwise nothing to click.

### Using it

- **Add text:** *Edit -> Add text box* arms click-to-place: the next click on a
  page drops an empty box with its top-left corner there and focuses it, so
  typing starts where you clicked. Escape, the banner's *Cancel*, or a click
  anywhere off a page disarms it, and the banner's *Place in the middle* drops
  the box centered on the current page instead — the keyboard path into the
  tool, since picking a spot needs a pointer (see
  [accessibility.md](accessibility.md#keyboard-shortcuts)). While a box is
  selected an inline inspector offers font (Sans / Serif / Mono), size,
  **bold**, and color. Drag anywhere on the box to move it, the corner to
  resize. Click empty space or press Escape to deselect.
- **Add image:** *Edit -> Add image* opens a PNG/JPEG picker, then arms
  click-to-place the same way; the image lands centered on the click,
  preserving its aspect ratio, and can be dragged and resized.
- **Add check mark:** *Edit -> Add check mark* arms click-to-place like the two
  above; the mark lands centered on the click at a fixed size (about 13pt
  square, matching a typical printed checkbox) and stays square if you resize it
  afterward. It differs from the other placing tools in one way: a click that
  lands on a real AcroForm field reaches the field instead of stamping a mark,
  because a mark exists only to stand in for a printed box that has *no*
  interactive field behind it. Filling in real form fields therefore still works
  while the tool is armed. Once placed, select a mark to switch it between check
  and cross in its inline inspector.
- **Save:** *Save* (`Ctrl/Cmd + S`) writes the edits back to the opened file
  (atomically, so a failed save cannot corrupt it); *Save a copy*
  (`Ctrl/Cmd + Shift + S`) writes them to a new PDF instead, leaving the
  original untouched.

Everything placed on a page can also be **moved and resized from the keyboard**,
so none of these tools needs a pointer once the item exists. `Tab` reaches a
placed text box, image, or check mark; the arrow keys move it, `Shift` + arrow
moves ten times as far, `+`/`-` resize it, and `Delete` removes it. The same
keys work on a placed signature and on an embedded image's selection. See
[accessibility.md](accessibility.md#nudging-a-placed-overlay) for the full table
and the reasoning behind the bindings.

### How it works

Edits are stored as a per-document sidecar (keyed by PDF fingerprint) in
`localStorage`, exactly like annotations and signatures. Each item is a
`NormalizedRect` (fractions 0..1 of the page, top-left origin) so it survives
zoom, plus its content:

```ts
type EditItem =
  | { kind: 'text'; rect; text; fontFamily; bold; fontSizePt; colorHex; ... }
  | { kind: 'image'; rect; dataUrl; mime; ... }
  | { kind: 'mark'; rect; glyph: 'check' | 'cross'; colorHex; ... };
```

- **On screen:** `EditLayer` (in `src/features/editing/`) renders each item over
  the page. Text font size is `fontSizePt * scale` so it tracks zoom; images fill
  their rect; marks render as an inline SVG stroke path (`MARK_GLYPH_PATHS`, a
  shared 0-100 unit shape) that scales to the rect, so they stay crisp at any
  zoom instead of rasterizing.
- **On save:** `stampEdits` (`src/features/editing/bake.ts`) loads the PDF with
  pdf-lib and draws each item. Normalized rects are top-left origin, PDF space is
  bottom-left, so the y-axis is flipped: `y = pageHeight - rect.y*pageHeight - h`.
  Text uses the `StandardFonts` enum (`drawText` with manual word-wrap to the
  box width); images use `embedPng` / `embedJpg` + `drawImage`; marks are
  stroked vector paths (`drawSvgPath`) using the same `MARK_GLYPH_PATHS` shape
  as the on-screen preview. `drawSvgPath` takes SVG-style (y-down) path
  coordinates and flips them internally, so unlike `drawImage`'s anchor (the
  *bottom* of the box), a mark's anchor is the box's *top* edge; see the
  comment in `bake.ts` for how this was confirmed.

### Limitations

- **Fonts are Latin (WinAnsi).** The standard PDF fonts (Helvetica, Times,
  Courier and their bold variants) cover Latin text. Characters they cannot
  encode are not drawn. Custom/Unicode fonts need `@pdf-lib/fontkit`, which is
  not wired up.
- **Wrapping is best-effort.** The baked line breaks approximate the browser's
  CSS wrapping; they will not be pixel-identical.
- **Marks are a fixed stamp, not free-form drawing.** The **Add check mark**
  tool always places a check; switch a selected mark to a cross, or back, from
  its inline inspector. A mark is always kept square as you resize it, in a
  chosen color; there is no ink or free-form annotation tool.

## Editing existing text

Click text that is already on the page and replace it, in place. This is
different from the tool above: instead of drawing something new over the page,
Folio finds the original show-text operator in the page's content stream,
removes it, and draws the replacement at the same spot. The edit applies to the
open document as soon as you commit it, not only when you save a copy.

### Using it

- Toggle **Edit text** in the Edit menu (`textedit.toggle`). While it is
  on, the page becomes clickable: click a run of text to open an inline editor
  prefilled with it, sized and colored to match the original as closely as
  PDF.js's own styles allow (font family, size, and fill color). A click that
  lands on a real AcroForm field reaches the field itself instead, so filling
  in form fields still works while the tool is armed.
- Type the replacement. **Enter**, or clicking elsewhere (blur), commits it.
  **Escape** cancels and leaves the original text in place.
- **Ctrl/Cmd + Z** undoes the most recent commit, up to 10 edits back. Undo is
  one stack for the whole document, not per page or per run, and it only fires
  when nothing else editable (a form field, the inline editor itself) has
  focus, so it never fights a native undo inside a text input.
- Clicking text Folio cannot safely edit shows a toast explaining why, instead
  of opening the editor (see Guardrails, below).
- Works the same way in the desktop app and the browser build: the whole
  feature is front-end only, with no Rust involvement.

### How it works

- **Locating a run.** `contentStream.ts` tokenizes and interprets the subset of
  content-stream operators needed to find every show-text operator (`Tj`, `TJ`,
  `'`, `"`): text-object delimiters (`BT`/`ET`), text positioning
  (`Td`/`TD`/`Tm`/`T*`/`TL`), font selection (`Tf`), the graphics-state stack
  (`q`/`Q`/`cm`), and fill color (`rg`/`g`/`k`/`sc`/`scn`/`cs`). For each one it
  records the byte range, the baseline origin in PDF user space, the effective
  font size, the active font resource, and the fill color. It also descends
  into `Do`-invoked Form XObjects, composing each form's own `/Matrix` into the
  position, so a run drawn by a template, a letterhead, or a form generator is
  located exactly like one on the page itself (see Guardrails for when it is
  still refused). Inline images are skipped rather than parsed.
- **Matching a click.** A click is converted from screen pixels to PDF user
  space through the page's own viewport (`PdfEngine.getPageViewport`), then
  matched against PDF.js's own per-item text content for the page
  (`PdfEngine.getTextItems`) by proximity to each item's baseline origin.
- **Splicing.** `spliceRun` removes the operator's bytes from the stream. A
  plain `Tj`/`TJ` closes the gap (or leaves a single space, if closing it would
  fuse two adjacent tokens together). `'` is replaced with `T*`, keeping the
  line advance the next line of text was written expecting. `"` is replaced
  with `aw Tw ac Tc T*`, keeping the word- and character-spacing side effects
  and the line advance, and dropping only the string itself.
- **Redrawing.** `mutate.ts` re-decodes the page's content stream(s) with
  pdf-lib, re-locates the same run, splices it, merges the page back into one
  uncompressed stream, and (unless the replacement is empty) draws the new text
  with the closest **Standard 14** font, Times, Courier, or Helvetica, with
  bold and italic picked from a hint carrying the original font's name, at the
  run's own baseline origin, size, and color. When the run lives inside a Form
  XObject, the shared form is never mutated in place: every form on the chain
  from the run up to the page is rewritten into a fresh copy (the edited form
  gets the spliced bytes; each form above it gets a new `/Resources`
  dictionary redirecting its `/XObject` entry to the copy below it), and only
  the page's own `/Resources` is updated to point at the top of that chain, so
  any other page or invocation still using the original form sees it
  byte-for-byte unchanged.
- **Committing.** The bytes edited are serialized fresh at commit time
  (`PdfEngine.saveDocument()`), so anything else changed while the editor was
  open, such as a form value, is not silently reverted; filled form values are
  preserved the same way. `reloadEditedBytes` (`src/state/actions.ts`) then
  swaps the engine's loaded document for the result, without resetting any
  per-feature store or the document's fingerprint, so annotations, signatures,
  and OCR state (all keyed by fingerprint) survive untouched. It bumps a
  `docVersion` counter that each page's render effect depends on, so every
  page repaints its canvas, text layer, and annotation layer in place from the
  new bytes instead of unmounting; scroll position is undisturbed, so there is
  nothing to restore. One consequence worth knowing: an in-place edit is
  already part of the document by the time you next run **Save a copy**; it
  does not wait for the additive tools' save-time bake step.

### Guardrails

Clicking (or, in one case, committing) text Folio cannot safely edit shows a
toast instead of corrupting the file:

- **Rotated or skewed text.** The replacement is always drawn upright at the
  original origin, so a rotated or skewed run is left alone rather than drawn
  wrong.
- **Runs that share positioning.** A show-text operator with no repositioning
  operator before the next one inherits wherever that next run left the text
  position. Removing it would shift its neighbor, so both are left alone.
- **Text inside a Form XObject the page draws more than once.** A single
  `Do` invocation of a form is editable like any other text; drawing the
  *same* form twice on one page (or otherwise invoking it more than once) is
  refused, because removing a run from the form's shared content stream would
  clear it from every invocation while the replacement is only ever drawn once.
- **Characters the standard fonts cannot encode.** This one is only caught when
  you commit, not when you click: if the replacement text cannot be encoded in
  the standard WinAnsi fonts, the edit is rejected and the original text is left
  in place.

### Limitations

- **A substituted font, not the original.** Replacement text is drawn with the
  closest Standard 14 font rather than the document's own embedded font, the
  same kind of substitution Acrobat falls back to when a font is unavailable.
- **One run at a time.** Each show-text operator is edited on its own; there is
  no reflow across a paragraph or a wrapped line.
- **Latin (WinAnsi) text only, for now**, same as the additive text tool.
  Bundling a Unicode font (`@pdf-lib/fontkit`) so non-Latin replacement text can
  be typed is a planned follow-up.
- **Undo holds full document snapshots, capped at 10.** Each entry is the whole
  document's bytes at that point, not a diff, so heavy undo use on a large
  document is more memory-hungry than a typical text editor's undo stack.

## Editing embedded images

Select an image already drawn on the page (not one of the additive overlay
images from the section above), then move it, resize it, or replace it with a
different PNG/JPEG. Like in-place text editing, the edit applies to the open
document as soon as you commit it, not only when you save a copy; unlike
in-place text editing, the image XObject itself is never touched, only the
operator that draws it.

### Using it

- Toggle **Edit** → **Edit images** (the corner-brackets icon, `imageedit.toggle`).
  While it is on, click an image on the page to select it: a bordered box
  appears with a draggable surface, a corner resize handle, a **Replace
  image…** button, and a delete button. A click that lands on a real AcroForm
  field reaches the field itself instead, so filling in form fields still works
  while the tool is armed. It is reachable without a pointer too: activating
  the same click target with Enter/Space selects the first editable image on
  the page instead of a specific one, or lets you know there is none to
  select.
- Drag the box to move the image, or its corner to resize it. Both commit once
  the pointer is released, the same way in-place text edits commit on blur
  rather than per keystroke: dragging only updates an on-screen preview until
  then, not the document.
- **Replace image…** opens the same PNG/JPEG picker **Add image** uses, and
  draws the picked file into the same rect the original image occupied.
- The delete button removes the image from the page outright.
- Click elsewhere on the page, or press Escape, to deselect.
- Clicking an image Folio cannot safely edit still selects it, so you can see
  what you clicked, but shows a toast explaining why instead of letting you
  move, resize, or replace it (see Guardrails, below).

### How it works

- **Locating an image.** `contentStream.ts`'s `parseContentStreams` takes an
  optional `onImageOp` sink, called for every `Do` operator it does not
  descend into (an Image XObject, most commonly): the resource name, its byte
  range, and the CTM in effect, which for an image is its *entire* placement
  (images paint the unit square, so there is no text matrix to combine it
  with the way a run's baseline origin needs). `imageedit/mutate.ts` resolves
  each name against the page's (or a form's) `/Resources`/`/XObject`
  dictionary, keeping only `/Subtype /Image`, and turns the CTM into an
  axis-aligned rect in PDF user space, normalized to positive width/height (a
  negative scale component means the image is mirrored on that axis; a
  rewrite preserves it rather than silently un-flipping the image).
- **Matching a click.** A click converts from screen pixels to PDF user space
  through the page's own viewport (`PdfEngine.getPageViewport`), the same way
  in-place text editing does, then picks the topmost located image whose
  rect contains the point.
- **Moving or resizing.** The `/Name Do` operator is rewritten in place as
  `q <A> cm /Name Do Q`, where `A` maps the image's current placement to the
  requested rect. Rewriting the same byte range, wrapped in `q`/`Q`, rather
  than appending to the stream, keeps the graphics state and the z-order
  exactly as they were.
- **Replacing.** The new PNG/JPEG is embedded (`pdf.embedPng`/`embedJpg`) and
  registered as a *new* resource in the page's `/XObject` dictionary; only the
  operator's name operand changes, reusing whatever matrix was already there
  untouched. The original image XObject is never mutated or repointed, since
  it can be `Do`-invoked from other pages, or more than once from this one.
- **Deleting** removes the operator's bytes outright, the same way an
  in-place text delete removes a show-text operator's.
- **Committing** follows the identical live-reload path in-place text edits
  use: the bytes are serialized fresh (`PdfEngine.saveDocument()`), mutated,
  and swapped in via `reloadEditedBytes`, which bumps `docVersion` so every
  page repaints without losing scroll position.

### Guardrails

- **Rotated or skewed images** (the CTM's `b` or `c` non-zero), or one with no
  visible size (its `a` or `d` scale is effectively zero), can still be
  replaced, since that reuses the matrix untouched, but moving or resizing one
  is refused: this feature does not recompute the matrix in either case.
- **Images inside a Form XObject** are not editable at all yet: moving,
  resizing, replacing, and deleting are all refused. Safely rewriting one
  would need the same clone-and-redirect discipline in-place text editing
  uses for a form (a fresh copy of the form for this page, with only its own
  resources redirected at the copy), which is not implemented for images yet.

### Limitations

- **One image at a time.** There is no multi-select or batch replace.
- **No dedicated undo.** Unlike in-place text edits (`Ctrl/Cmd + Z`, up to 10
  edits), an image edit cannot be undone from the keyboard; closing the
  document without saving is the only way back.
- **Images inside a Form XObject are read-only for now** (see Guardrails).

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
  `script-src` includes `'wasm-unsafe-eval'`, and `worker-src` and
  `connect-src` both include `'self'`.
- Those files are large and derived, so they are **git-ignored** and populated by
  [`scripts/setup-ocr-assets.mjs`](../scripts/setup-ocr-assets.mjs), which copies
  the worker/core from the pinned `tesseract.js` / `tesseract.js-core` packages
  and downloads the model once from the tesseract.js maintainers' data host. The
  `predev` / `prebuild` npm hooks run it automatically; run it by hand with
  `npm run setup:ocr`. See [getting-started](getting-started.md#ocr-assets).

A `.js` `corePath` is passed to tesseract.js, which pins the SIMD-LSTM core and
skips its runtime SIMD auto-detection. Baseline wasm SIMD is supported by
WebView2 and modern browsers, Folio's only targets.

### Not in the Chrome extension

OCR is absent from the [Chrome extension](../extensions/chrome/README.md) build:
the commands and the menu row are compiled out, so the feature does not appear
rather than appearing and failing.

Two reasons, and the second is the blocking one.

The runtime is 8.4 MB, which was 77% of the extension's packed size, and the
Chrome Web Store bans remote code, so it cannot be fetched on demand — it either
ships in the package or it does not exist there.

More importantly, it would not work as written. The paths above are **absolute**
(`/tesseract/...`), and the extension viewer is served from
`chrome-extension://<id>/dist/`, where an absolute path resolves above the
viewer and 404s. Bundling the assets would not have been enough. Making OCR work
in the browser extension means giving `recognize.ts` a base-relative asset path
first; `--with-ocr` alone only makes the package bigger.

### Limitations

- **English only** for now. Other languages need their own `traineddata` and, for
  non-Latin scripts, a Unicode font for the baked layer (`@pdf-lib/fontkit`).
- **Alignment is approximate.** The invisible layer is positioned per word box,
  which is more than enough for search and copy but is not a pixel-perfect glyph
  overlay.

## Where the code lives

| Piece | Path |
| --- | --- |
| Editing store, overlay, commands (text boxes, images, check marks) | `src/features/editing/` |
| Editing bake (pdf-lib): text/image draw, mark stroke (`drawSvgPath`) | `src/features/editing/bake.ts` |
| In-place text edit: content-stream parser + splice | `src/features/textedit/contentStream.ts` |
| In-place text edit: pdf-lib splice + redraw | `src/features/textedit/mutate.ts` |
| In-place text edit: overlay, store, commands | `src/features/textedit/` |
| Image `Do` geometry (shared by in-place text edit's parser) | `src/features/textedit/contentStream.ts` (`LocatedImageOp`, `onImageOp`) |
| Image editing: object-model resolution + move/resize/replace/delete | `src/features/imageedit/mutate.ts` |
| Image editing: overlay, store, commands | `src/features/imageedit/` |
| Live reload after a commit (swaps engine doc, bumps `docVersion`) | `src/state/actions.ts` (`reloadEditedBytes`) |
| Page viewport + raw text items (for hit-testing) | `src/core/pdf/PdfJsEngine.ts` (`getPageViewport`, `getTextItems`) |
| OCR recognition + worker | `src/features/ocr/recognize.ts` |
| OCR store, text layer, modal, commands | `src/features/ocr/` |
| OCR bake (invisible layer) | `src/features/ocr/bake.ts` |
| Search fallback | `src/features/ocr/search.ts` |
| Page rasterize | `src/core/pdf/PdfJsEngine.ts` (`renderPageToImage`) |
| Export pipeline (loads pdf-lib once) | `src/features/export/saveDocument.ts` |
| Self-hosted OCR assets | `scripts/setup-ocr-assets.mjs`, `public/tesseract/` |

Manual test steps for text boxes and images are in
[testing.md](testing.md#editing-text-boxes-images-and-check-marks); steps for in-place text
editing are in [testing.md](testing.md#editing-text-in-place); steps for
editing embedded images are in
[testing.md](testing.md#editing-embedded-images).
