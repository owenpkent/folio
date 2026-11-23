# Redaction

Design for true redaction in Folio (roadmap v0.4, "Redaction: true redaction that removes underlying content, not just a black box"). Nothing here is built yet. This document fixes the guarantee, the algorithm, and the order of work before any code is written.

Items marked **(unverified)** are claims the author could not confirm from the code or the PDF specification and that need a spike or a test before the design relies on them.

## Goal and threat model

After a user applies a redaction and saves, the covered content must be gone from the file, not hidden. Concretely, the saved file must not let a reader recover it by:

1. **Text extraction or copy.** Neither PDF.js nor any other extractor returns the redacted glyphs, including from hidden text layers and OCR layers under the region.
2. **Image extraction.** The pixels under the region are not present in any image object reachable from the saved file, in the original resolution or any other copy. That includes copies no operator draws: an image still listed in a page's `/Resources`, and the page's embedded thumbnail (`/Thumb`).
3. **Revision history.** The saved file holds no earlier revision of the document. A file that ends with an incremental update still contains the pre-redaction bytes.
4. **Orphaned objects.** Content streams, images, and annotations that nothing references any more are not serialized.
5. **Metadata and side channels.** Annotation contents, form field values, `/Info`, XMP, and replacement text (`/Alt`, `/ActualText`, `/E`) that restate the redacted words are removed, whether that text sits in the structure tree or in a marked-content property list inside the content stream.

The attacker is anyone who receives the saved file and runs a parser, a text extractor, or a hex editor over it. Folio does not defend against the original, unredacted file that the user still has, or against what a recipient already saw.

### Non-goals for v1

- Redaction codes and exemption labels; overlay text is free-form.
- Rewriting JPEG, JPEG 2000, JBIG2 or CCITT pixels in place (those images are removed whole).
- Encrypted files. Folio never decrypts a protected PDF, so it is view, fill and print only and the Redact tool is disabled with a reason.
- Signed files. Redaction would void the signature, so Folio refuses to redact a signed document and says why.
- OCR-driven marking of scans, pattern locales beyond US formats, batch redaction.

## UX flow

1. **Mark.** A **Redact** tool (`redact.toggle`, keyboard-reachable like the other edit tools) lets the user drag a rectangle, or select text and mark the selection. A marked region is a pending mark held in a store, drawn as an outlined rectangle with a translucent red wash. Marks are not yet in the PDF.
2. **Search and redact.** A panel runs a text query or a built-in pattern (email, phone, SSN, credit card, date) over each page's extracted text and creates marks for the hits, mapped to glyph boxes. The user reviews the list and unticks false positives.
3. **Review.** A summary lists marks per page and the categories that apply (text, images, annotations, form fields, metadata). Document metadata (`/Info`, XMP) is always removed on apply, and the summary lists what will go. Marks can be edited, moved, or deleted freely until applied.
4. **Apply.** A confirmation dialog states that this cannot be undone in the saved copy. Apply runs the algorithm below on a copy of the document bytes and verifies the result. On any verification failure nothing changes (fail closed).
5. **Save as a new file.** After apply, the in-place **Save** is disabled for this document and **Save a copy** is the only path, defaulting to a name like `name (redacted).pdf`. The open document is reloaded from the redacted bytes. The existing text-edit undo stack is cleared, because its snapshots hold the unredacted bytes.

Apply is irreversible for the saved file only. The in-memory pre-apply bytes are dropped on apply so a later "undo" cannot leak into a save.

## Removal algorithm

All of it runs in the renderer on pdf-lib objects. The Rust side stays file IO only.

### Region specification

A mark is `{ pageIndex, rects: [x0, y0, x1, y1][] }` in **PDF user space** (bottom-left origin), one rectangle per selected text line or drawn area. Marks are created in viewport coordinates and converted with `PdfEngine.getPageViewport` and `src/core/pdf/pageGeometry.ts`, which already handle `/Rotate`. Rectangles are normalized (min/max) and clamped to the page box. Page `/Rotate` and non-zero `/MediaBox` origins are covered by tests (below).

### Text

Interpret each content stream tracking the CTM stack, text state (font, size, `Tc`, `Tw`, `Tz`, `Ts`, `TL`), and `Tm`/`Tlm`. For every glyph compute its box in user space: `Trm = [size*Th 0 0 size 0 rise] x Tm x CTM`, then the box `[0, descent, width, ascent]` through `Trm`. A glyph is removed if its box overlaps a rectangle by more than a small tolerance. Removal replaces the glyph bytes with a `TJ` displacement of the same advance, so the rest of the line keeps its position. `'` and `"` are rewritten to `T*` (plus `Tw`/`Tc`) so their side effects survive, which `spliceRun` in `contentStream.ts` already does for whole operators.

Character codes are split by font type: one byte for simple fonts; for Type0 fonts, by the `/Encoding` CMap code-space ranges **(unverified: Identity-H two-byte is the common case; other CMaps need a parser)**. Widths come from `/Widths` and `/FirstChar` (simple), `/W` and `/DW` (Type0), `/FontMatrix` (Type3). If a font's widths cannot be read, the fallback is to remove the **entire show operator** and report it. That over-redacts but never leaves text behind.

Modes: render modes 3 (invisible) and 7 (clip) are treated as text like any other, so an OCR layer under a region is cut. Text drawn with a zero-size or degenerate box counts as a hit when its origin is inside a region.

Marked content: a `BDC` operator can carry replacement text in its property list, as an inline dictionary (`/Span << /ActualText (...) >> BDC`) or by name through the `/Properties` resources. That text restates the glyphs it wraps, and nothing needs the glyphs to read it. When any glyph inside a marked-content sequence is removed, `/ActualText`, `/Alt` and `/E` are removed from that sequence's property list. An inline dictionary is rewritten in the stream. A named one is cloned, without those keys, to a new `/Properties` name on the redacting page, and the `BDC` is pointed at the new name; the original dictionary is never edited where other pages share it. Cloning is only half of it: the old name still maps to the old dictionary, replacement text included, and a resource entry is reachable whether or not any operator uses it. So the old mapping is pruned from the redacted page's own `/Resources` as soon as no remaining `BDC` or `DP` in that page's final content uses the name (the same private copy of `/Resources`, and the same care for inherited and shared dictionaries, as for images below). If an untouched sequence on the page still uses the name, the mapping stays for it: that text was redacted here, not there. Removing the glyphs alone leaves the words in the file while PDF.js text extraction returns nothing, so the verifier checks this case directly (see Verification).

### Images

- **Image XObject fully inside a region:** drop the `Do` operator, and remove the image's entry from the `/Resources` that named it. Dropping the operator is not enough: the sweep keeps everything reachable from the page, and a resource entry is reachable whether or not anything draws it, so the pixels would stay in the file. The entry goes when no remaining operator in a stream that uses those resources draws that name. A redacted page gets its own `/Resources` for this, copied first if the dictionary is inherited from `/Pages` or shared with other pages, so pruning cannot take a resource away from a page that was not redacted. That private copy is pruned by use in every category, not only `XObject`: a name its final content does not reference is dropped, which is also what removes an obsolete `/Properties` mapping. If another page or form still draws the image it stays, which is correct: it was redacted here, not there. **(unverified: a shared resource dictionary can list the image for a page that never draws it, so finding every dictionary that names it needs a document-wide scan; phase 0 sizes that.)**
- **Page thumbnails (`/Thumb`):** an embedded thumbnail is a small picture of the whole page as it was before redaction. It is deleted from every redacted page and not regenerated (viewers draw their own). Nothing draws it, so no operator-level check sees it. `/PieceInfo`, an application's private data that can hold its own copy of page content, is removed from redacted pages as well **(unverified: how often it holds page content)**.
- **Partly covered, lossless filters (Flate, LZW, ASCII85, ASCIIHex, RunLength):** decode, set the covered pixels to zero (or to the paint-nothing bit for image masks), re-encode as Flate, and register the result as a **new** XObject. The original is never edited because other pages may draw it. Pixel coverage is decided by mapping each pixel centre through the CTM into user space.
- **Partly covered, DCT, JPX, JBIG2, CCITT:** v1 removes the whole image (fail closed). Phase 3 can decode JPEG through `createImageBitmap` and a canvas, blank pixels, and re-encode as Flate (lossless, larger) or JPEG at high quality. Folio already decodes and embeds PNG/JPEG in `imageedit`, but has no pixel-level decode of PDF image data.
- **Soft masks and masks** (`/SMask`, `/Mask`) are cleared the same way, or dropped with the image. A leftover mask can leak the shape of the image.
- **Inline images (`BI ... EI`):** the tokenizer already skips them (`skipInlineImage`). Under a region, remove the whole `BI..EI`. Their bounding box is the CTM's unit square.
- **Tiling patterns and shadings** that paint under a region: wrap the paint in `q`, clip out the region with an even-odd clip, then `Q`.

### Vector paths

Track each path's bounding box in user space. Fully covered paths are dropped (keeping a clip if the path also clips); partly covered ones are wrapped in `q <even-odd clip excluding the rects> ... Q`. This is a visual guarantee only: the coordinates stay in the file. State that limit in the UI.

### Form XObjects

Folio's text-edit already descends into forms and composes `/Matrix`, with a `MAX_FORM_DEPTH` of 8 and a `MAX_FORM_DESCENTS` budget. Redaction needs the same walk with these differences:

- A form is processed whenever its transformed `/BBox` touches a region, no matter how many times it is invoked. Text-edit refuses a form drawn twice; redaction cannot, because a region may cover only one invocation.
- Never rewrite a form in place. Rewrite it into a **new** stream object, with a new `/Resources` entry on the caller, and point only the redacting page at it. The pattern is the clone-and-redirect chain in `src/features/textedit/mutate.ts`.
- A form invoked at two places on one page, with only one covered, needs two copies: the redacted one and the original. The caller renames the covered `Do` to the new XObject name.
- Over the depth cap, remove the `Do` rather than skip it.

### Annotations, fields, and tags

- Remove every annotation whose `/Rect` overlaps a region, with its `/Popup`, `/AP` streams and `/Contents`. Links over a region go too.
- A widget under a region deletes its whole field (all widgets, `/V`, `/DV`, appearance streams) and its entry in `/AcroForm /Fields`. `pruneAcroForm` in `src/features/pageops/mutate.ts` already prunes fields for dropped pages and can be reused.
- Form field values that restate redacted text but are not under a region are out of scope for automatic detection. The Search and redact panel also searches field values and annotation text and offers them as marks.
- Structure tree: for each changed marked-content sequence (by `MCID`), drop `/Alt`, `/ActualText`, and `/E` on the owning element, and drop the `MCR` reference when the sequence is empty. `doomedStructElements` in `pageops` is a starting point.
- `/Info` and XMP are removed on every apply, with no opt-out, and listed in the review step. Outlines and named destinations are scanned for the redacted strings and cleared in v1 as a blunt category rather than matched.

### Overlay

After removal, draw the box and optional overlay text (Standard 14 font, as `editing/bake.ts` does) in a new last content stream marked so the verifier skips it.

### Save path

Redaction must not use the PDF.js `saveDocument()` result alone. `exportDocument` in `src/features/export/saveDocument.ts` starts from `getEngine().saveDocument()`, which writes filled form values; its output is **an incremental update on the original bytes (unverified for the no-forms case)**, so earlier revisions would remain. Rules:

1. Run apply on bytes that have been through `PDFDocument.load` and `save`. pdf-lib's parser reads object bodies in file order and later definitions of an object number overwrite earlier ones, so superseded revisions of the same object are dropped. This is read from `node_modules/pdf-lib/cjs/core/parser/PDFParser.js` and **(unverified: needs a test with a real incremental file)**.
2. pdf-lib's writer serializes every indirect object still registered on the context, reachable or not. `computeBufferSize` iterates `enumerateIndirectObjects()` (`PDFWriter.js`). `src/features/pageops/gc.ts` records the same fact and ships `sweepDroppedPages`, a mark-and-sweep from the trailer. This was confirmed by reading the writer source; the existing page-delete tests exercise it.
3. So after apply, run a **full mark-and-sweep from the trailer** (generalize `gc.ts`: today it is told which pages to refuse to walk; for redaction it walks from the trailer with no skips and deletes everything unreached). Orphaned original content streams and images then drop out. Without this step the old unredacted streams survive, because the page's `/Contents` now points at new objects.
4. Save with `useObjectStreams: false` and `updateFieldAppearances: false`, as `applyPagePlan` does, so the output is a plain file that is easy to scan.
5. Assign a fresh trailer `/ID` (`assignFreshDocumentId`) so the redacted copy does not inherit the source's sidecar fingerprint.
6. In-place Save is blocked after apply; see UX.

## Verification

Apply returns bytes only after a verifier passes. It is independent of the rewriter and fail-closed.

1. Re-parse the saved bytes with a fresh `PDFDocument.load` (reachability) and PDF.js (rendering and text).
2. **Text:** for each redacted page, call `getTextContent` and assert that no item's box overlaps a region and that each redacted string appears in the page text no more often than it was shown outside the regions before apply. The same word elsewhere on the page was not marked, so it stays, and a check that forbade it would reject a correct result. PDF.js text items are per run, not per glyph, so this is a coarse check **(unverified: per-glyph boxes may need `getOperatorList`)**.
3. **Operators:** re-run the interpreter in verify mode over the final streams (including forms) and count glyphs and inline images still overlapping a region. Anything above zero fails. So does a marked-content sequence that lost a glyph and still carries `/ActualText`, `/Alt` or `/E`.
4. **Bytes:** for every redacted string of three or more characters, search the decoded and raw bytes of all objects, and the metadata, for the Latin-1 and UTF-16BE forms. Compressed streams are inflated first. A hit fails unless it is content the removal rules deliberately keep: the same string shown by glyphs outside every region, on this page or another, which the user did not mark, or a property dictionary retained for untouched content (check 6). Every other hit fails: metadata, an annotation, a form value, an orphaned stream, an obsolete property dictionary. **(unverified: telling a kept hit from a leftover means mapping a byte offset in a content stream back to its show operator.)** Shorter strings are not searched, because one or two characters match by chance everywhere. This check therefore cannot stand in for the structural ones: a two-character `/ActualText` is caught by check 3, not here.
5. **Pixels:** rasterize each redacted page with PDF.js and assert that, outside the overlay text, the pixels inside each region equal the fill color.
6. **Objects:** the rewriter records, for everything it removes, whether untouched content still uses it: another page or form that still draws a dropped image, or an untouched marked-content sequence (on this page or another) that still uses a property dictionary. The check is scoped by that record, so it rejects what is obsolete and accepts what the removal rules deliberately keep.
   - **Obsolete objects are gone.** Anything with no recorded remaining use is not in the context after the sweep: the original content streams, a dropped or cleared image nothing else draws (what matters is that it is reachable, not whether an operator draws it), each redacted page's original `/Thumb`, and an indirect property dictionary no untouched sequence uses.
   - **Retained objects are reachable only through their recorded uses.** An image another page still draws, or a property dictionary an untouched sequence still uses, may remain. It must not be reachable from a redacted page's `/Resources` unless the recorded use is on that page.
   - **Each redacted sequence is clean.** Its `BDC` carries no replacement-text keys, inline or through the name it now points at, which is the sanitized clone and never the original.
   - **Each redacted page holds nothing unused.** Its `/Resources` names no XObject and no `/Properties` entry its final content does not use, and the page has no `/Thumb`. A property dictionary written directly inside `/Resources` has no object of its own to look for, so for it this is the whole check: its name is absent from the page's `/Properties` unless an untouched sequence on the page still uses it.

Failure rolls back to the pre-apply bytes with an error that says which check failed.

## Test plan

Fixtures are tiny PDFs built with pdf-lib in test setup, plus a few hand-written streams. Each case asserts the removal and the verifier. The corpus robustness harness (`npm run test:corpus`, see [testing.md](testing.md)) adds a round-trip over real-world files on top.

| Case | What it proves |
| --- | --- |
| Text split across a `TJ` array with kerning numbers, region covering the middle | Glyph split keeps the line's later text at the same x |
| `Tj` after `Tc`, `Tw`, `Tz`, `Ts` | Advance math matches PDF.js item positions within 0.5pt |
| `'` and `"` operators | Leading and spacing side effects survive |
| Type0 Identity-H font with `/W` and `/DW` | Two-byte codes split correctly |
| Type3 font (glyph procs, `/FontMatrix`) | Either removed by width, or whole-operator fallback fires and is reported |
| Rotated text (`Tm` at 90 degrees) | Boxes computed through `Trm`, not assumed upright |
| Invisible text (`Tr 3`, an OCR layer) under a region | Removed; verifier counts it |
| Text in a Form XObject reused on two pages, region on one | Page A redacted via a new form; page B bytes and its form object unchanged |
| One form invoked twice on one page, region on one | Two forms exist after apply; the uncovered one is intact |
| Inline image under a region | `BI..EI` removed |
| Flate RGB image, region over a corner | New XObject with cleared corner; original XObject not referenced |
| Image fully under a region on one page and drawn, untouched, on another | Gone from the redacted page's content and `/Resources`; the other page still draws it; the complete verifier accepts the result |
| JPEG (DCT) image, partly covered | Whole image removed; report says so; JPEG bytes absent from the file |
| Image fully under a region and drawn nowhere else | `Do` gone and the entry gone from the page's `/Resources`; the image's pixels are not in the file |
| The same, with `/Resources` shared by a second page that never draws the image | Redacted page gets its own pruned `/Resources`; the other page still renders; the image is not in the file |
| Page with a `/Thumb` | Thumbnail removed; its pixels are not in the file |
| Image with `/SMask` | Mask cleared or dropped with the image |
| Annotation with an appearance stream over the region | Annotation, `/AP`, and `/Contents` gone |
| Text field under the region with `/V` set | Field, `/V`, `/DV`, and AP removed from `/AcroForm /Fields` |
| `/Info` and XMP containing the redacted name | Cleared on every apply; byte search finds nothing |
| Signed document | Redaction refused with a reason; bytes unchanged |
| Encrypted document | Redact tool disabled with a reason |
| Structure tree with `/Alt` and `/ActualText` on a redacted span | Both removed |
| `/ActualText` on an inline `BDC` property list around redacted glyphs | Key removed from the stream; PDF.js text and a search of the decoded stream both find nothing |
| The same through a named `/Properties` entry shared with another page | Redacting page uses a cloned entry without the key; the other page's entry is unchanged |
| Two-character `/ActualText` in a named `/Properties` entry used only by the redacted sequence, as an indirect object and as a direct dictionary | After sweep and save the old name is gone from the page's `/Resources /Properties` and the text is not in the file; asserted structurally, because the byte search skips a string this short |
| The same name also used by an untouched sequence on the page, as an indirect object and as a direct dictionary | The mapping stays for that sequence, replacement text included; the redacted sequence uses the clean clone; the complete verifier accepts the result |
| Two-character redacted string under `/ActualText` | Caught by the operator check; the byte search (three or more characters) would miss it |
| Rotated page (`/Rotate 90`, 270) and a non-zero `/MediaBox` origin | Marks land on the right glyphs |
| File with an incremental update that changed the page content | Old content stream bytes absent from the output |
| Redacted text that previously sat in a deleted object (orphan) | Absent from the output; this is the sweep test |

Round-trip check on each fixture: output reloads in PDF.js and renders; page count and unrelated text are unchanged.

## Phased implementation

Rough sizes are for one developer, in days of focused work.

| Phase | Scope | Size |
| --- | --- | --- |
| 0. Spikes | Confirm `PDFDocument.load` + `save` drops superseded revisions on an incremental file; confirm `saveDocument()` output shape; decide per-glyph width source (pdf-lib font dicts vs PDF.js); size the document-wide scan for resource dictionaries that name a dropped image | 2 days |
| 1. Text core | Glyph-level interpreter (state, widths, Type0 codes), `TJ` rewrite, whole-operator fallback, marked-content property cleanup, form cloning, full trailer sweep, verifier (operators and bytes) | 8 to 10 days |
| 2. Marking UI | Redact tool, mark store, apply dialog, save-as-new-file flow, text selection to marks, keyboard support | 5 days |
| 3. Images, vectors | Flate clear, whole-image drop with resource pruning, thumbnail removal, inline images, clip-out of paths and shadings, pixel verifier | 5 days |
| 4. Annotations, fields, tags, metadata | Annotation and field removal, structure tree cleanup, metadata scrub | 4 days |
| 5. Search and redact | Patterns, review list, hit-to-glyph mapping | 3 days |
| 6. Hardening | Test matrix above, fuzzing the interpreter (as `contentStream.fuzz.test.ts` does), docs and manual test steps | 4 days |
| Later | JPEG re-encode, OCR-based marks, redaction codes | 3 to 5 days each |

About 30 to 35 days to v1.

## What Folio already has, and what is missing

Reusable: the tokenizer and splice helpers in `src/features/textedit/contentStream.ts` (`parseContentStreams`, `spliceOperatorBytes`, `removeOperatorBytes`, `spliceRun`; it tracks CTM, `Tm`, font and size and descends into forms); `decodePageContentStreams`, `mergeStreams` and the form clone-and-redirect code in `textedit/mutate.ts`; image placement in `imageedit/mutate.ts` (`onImageOp`); `pageops/gc.ts` and `verifyResult`; `core/pdf/pageGeometry.ts`; `withDocumentMutation` and `reloadEditedBytes`; `assignFreshDocumentId`.

Missing: per-glyph layout (the interpreter emits one run per show operator, with no code splitting, no width tables, and no `Tc`/`Tw`/`Tz`/`Ts` modelling, and it refuses rotated text); redaction's opposite rule for forms invoked more than once; path bounding boxes and clip-out generation; pixel decode and encode of PDF image data; a trailer-rooted sweep that is not page-scoped; resource pruning after a dropped image, thumbnail removal, and rewriting of marked-content property lists; the verifier; the marks store and UI; and annotation, field, tag and metadata removal.

## Lessons from pdfcraft

[storytold/pdfcraft](https://github.com/storytold/pdfcraft) is a pure-Rust Acrobat clone (MIT OR Apache-2.0) whose `crates/redact` already does most of this. The design above borrows its structure; the code is Rust and is not copied. Credit and thanks to its authors. Paths below are in that repository.

- **Marks are annotations, apply is one pass.** `crates/redact/src/lib.rs` models a mark as a `/Redact` annotation (`QuadPoints`, `/IC` fill, overlay text), runs `apply` over all pages, and returns a `Report` of counts. Folio keeps marks in a store instead, since pdf-lib annotations would add a round trip, but the `Report` idea is worth copying for the review dialog.
- **Glyph-level splitting with displacement.** `crates/redact/src/interp.rs` (`show`) lays out each string glyph by glyph and replaces hit glyphs with a `TJ` number equal to the advance, so the line does not shift. Its hit test accepts overlap above a fifth of the glyph (capped at one point) so neighbours that touch an edge survive; zero-size glyphs count when their origin is inside.
- **Copy-on-write for shared content.** Rewritten forms and cleared images become new objects (`xobject` in `interp.rs`, `crates/redact/src/image.rs`), never edits of the shared original.
- **Fail closed on unknown codecs.** `image.rs` clears pixels only for Flate, LZW, ASCII85, ASCIIHex, and RunLength; DCT, JPX, JBIG2, and CCITT images are removed whole. Roadmap lists "DCT re-encoding" as missing. Folio adopts the same v1 line.
- **A verify pass that can abort.** `apply` in `lib.rs` re-reads every redacted page in `Mode::Verify` and returns `RedactError::Residue` if any glyph or inline image remains, leaving the document unchanged. Its verifier shares the interpreter with the rewriter; Folio's bytes, pixels, and object checks are stricter in places (below).
- **Full rewrite is a flag.** `Document::require_full_save` in `crates/cos/src/document.rs` forces the next save to use `write_full`, which writes only objects reachable from the trailer (`crates/cos/src/writer.rs`). Folio needs the explicit sweep because pdf-lib has no equivalent.
- **Tag cleanup.** `crates/redact/src/tags.rs` compares each MCID's operators before and after and strips `/Alt`, `/ActualText`, and `/E` from affected elements. Adopted.
- **Hidden information as a separate tool.** `crates/redact/src/sanitize.rs` lists nine categories (metadata, attachments, comments, form fields, hidden text, hidden layers, bookmarks, links and scripts, private data) and makes each force a full save.
- **Patterns.** `crates/redact/src/patterns.rs` has phone, email, credit card, SSN, and date matchers returning character ranges, which callers map to glyph boxes. Folio's phase 5 follows that shape.

Gaps seen in pdfcraft (read from the code, not run): Type3 and unusual fonts get approximate metrics (`crates/fonts/src/pdf.rs`), so Folio adds a whole-operator fallback; partly covered vectors are clipped, not rewritten; image masks and soft masks are not visibly handled in `image.rs`; verification checks operators only, with no byte, pixel or reachability check; and metadata and tags live in separate tools (`sanitize.rs`, `tags.rs`), so Folio ties the metadata scrub to apply.
