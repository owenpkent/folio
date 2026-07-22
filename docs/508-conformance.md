# Section 508 conformance

This page records how Folio stands against the **Revised 508 Standards**
(36 CFR Part 1194), what is implemented, and what is not. It is the working
document behind any Accessibility Conformance Report (ACR) we publish, so it is
written to be accurate rather than flattering: a gap named here is cheaper than
a gap a federal buyer finds during evaluation, and an ACR that overclaims is a
contractual problem, not an embarrassment.

For the day-to-day accessibility model — the keyboard map, focus rules, ARIA
structure, the text layer — see [accessibility.md](accessibility.md). This page
covers only what 508 adds on top and where we fall short.

## What 508 actually requires

Section 508 defines almost no accessibility rules of its own. It **incorporates
WCAG 2.0 Level A and AA by reference**, in two places:

- **E205.4** for electronic content
- **E207.2** for software user interfaces

both citing WCAG 2.0 via **702.10.1**. Level AAA is not incorporated.

Two consequences worth internalising:

1. **It is still WCAG 2.0**, not 2.1 or 2.2. The only amendment to 36 CFR 1194
   since 2017 (83 FR 2915) fixed typographical errors and restored TTY
   requirements; it did not touch WCAG. As of this writing there is no pending
   rulemaking to update it. Folio targets **WCAG 2.2 AA**, which is a superset,
   so meeting our own target satisfies the incorporated standard.
2. **Do not confuse 508 with the DOJ ADA Title II rule** (28 CFR Part 35), which
   adopted WCAG 2.1 AA in 2024. That rule binds state and local government, not
   federal agencies, and has no effect on 508.

So the interesting part of 508, for us, is the handful of provisions that WCAG
does not cover at all: platform settings (503.2), authoring tools (504), and
support documentation and services (Chapter 6).

## Status by provision

| Provision | Requirement | Status |
|---|---|---|
| **E205.4 / E207.2** | Content and UI conform to WCAG 2.0 A/AA | **Supports**, with the exceptions in [accessibility.md](accessibility.md) |
| **502.2.2** | Does not disrupt platform accessibility features | Supports |
| **502.3** | Applications that are also platforms expose accessibility services | **Partially supports** — see [Canvas content](#canvas-content-5023) |
| **502.4** | Platform accessibility features (ANSI/HFES 200.2) | Not applicable — Folio is an application, not a platform |
| **503.2** | Honor platform color, contrast, font type, font size, focus cursor | **Supports** — see [Platform settings](#platform-settings-5032) |
| **503.4** | Caption / audio description controls | Not applicable — no video or audio |
| **504.2** | Authoring: a mode producing WCAG-conformant content | **Partially supports** |
| **504.2.1** | Preserve accessibility information on save / format conversion | **Partially supports** — see [Preservation](#preservation-on-save-50421) |
| **504.2.2** | Capable of exporting PDF/UA-1 | **Does not support** — see [PDF/UA export](#pdfua-export-50422) |
| **504.3** | Prompts to create conformant content | **Does not support** — no alt-text prompt exists |
| **504.4** | Accessible templates | Not applicable — Folio ships no templates |
| **602.2** | Documentation lists and explains accessibility features | Supports — [accessibility.md](accessibility.md) |
| **602.3** | Electronic documentation conforms to WCAG 2.0 A/AA | Supports — plain Markdown rendered by GitHub |
| **602.4** | Alternate formats on request | Supports — see [Support](#support-documentation-and-services-chapter-6) |
| **603.2 / 603.3** | Support services convey accessibility info and accommodate needs | Supports — see [Support](#support-documentation-and-services-chapter-6) |

### Is Folio an authoring tool?

Almost certainly yes, and we plan on that basis.

508 defines an authoring tool (**E103.4**) as *"any software... that can be used
by authors, alone or collaboratively, to create or modify content for use by
others, including other authors."* Folio creates highlights, sticky notes, ink
signatures, text boxes and OCR text layers, edits text already on a page in
place, and writes all of it back to the opened file or into a saved copy. That
is content creation (and,
for in-place text edits, content modification in the plainest possible sense)
on any plain reading, independent of whether form-filling counts.

Worth knowing precisely, because it will come up: **the Access Board never
addressed annotation or form-filling in the final rule.** The terms
"annotation", "form field", "fillable" and "filling in" appear zero times in
82 FR 5790. Anyone asserting that form-filling is or is not authoring is
interpreting, not citing. We assume 504 applies rather than litigate the edge,
which is also the conservative posture for an ACR.

Note that ATAG 2.0 Level AA conformance is an accepted route: the Board's own
preamble states that *"authoring tools that provide Level AA conformance to
ATAG 2.0 will conform to these Standards and Guidelines."*

## Platform settings (503.2)

503.2 requires that an application *"permit user preferences from platform
settings for color, contrast, font type, font size, and focus cursor."* WCAG has
no equivalent requirement, and this is one of the most commonly failed
provisions.

There is an exception for *"applications designed to be isolated from their
underlying platform software, including Web applications."* **We do not rely on
it.** Folio ships as a desktop binary via Tauri, and a desktop app is not
obviously a web application for this purpose; the browser build is the same
code, so the desktop build sets the floor.

Implemented (`src/theme/tokens.css`, covered by `e2e/accessibility.spec.ts`):

- **Color and contrast.** `prefers-color-scheme` drives the theme. Under
  `forced-colors: active` (Windows High Contrast) every design token resolves to
  a system color keyword, so the UI is drawn in the user's own palette.
- **State that outlives a flattened palette.** Forced colors collapse the
  background-color change that signals a toggled button, so toggled controls get
  an explicit outline. Shadows are dropped, since the browser does not force them
  and an author-colored shadow would survive as a smudge.
- **The document opts out.** The page canvas sets `forced-color-adjust: none`: a
  PDF is content and must render as its author wrote it, not remapped. Dark
  mode's own page inversion still applies on top, being the user's own explicit
  choice.
- **Font size.** UI sizes are in `rem`, so the OS/browser font-size preference
  scales the interface.
- **Focus cursor.** Focus is never removed and is styled from `--folio-focus`,
  which resolves to `Highlight` under forced colors.

**Not covered: font type.** Folio uses the platform UI font stack
(`system-ui`), so it follows the platform's default, but there is no setting to
honor a user's specific font choice beyond that.

## Canvas content (502.3)

502.3's second sentence — *"Applications that are also platforms shall expose
the underlying platform accessibility services or implement other documented
accessibility services"* — is the one that reaches us. Folio hosts a rendering
surface, and pixels on a `<canvas>` expose nothing to UI Automation or
NSAccessibility.

We satisfy the substance of this by maintaining a real DOM text layer over the
canvas, which the WebView maps to the platform accessibility API for us: on
Windows WebView2 maps the DOM to UIA, on macOS WKWebView maps it to AX. The
canvas itself is `aria-hidden`.

It is a **partial** support because the text layer is positioned spans with no
structure attached — see the reading-order gap below.

## The gaps

### Reading order is content-stream order

Folio does not read the PDF's structure tree. `renderAnnotationLayer` passes
`structTreeLayer: null`, `page.getStructTree()` is never called, and the text
layer carries no structure. Reading order therefore comes from
`getTextContent()`, which follows the content stream **even when the document is
tagged and its tags describe a different logical order**. For most documents the
two agree; for multi-column layouts, sidebars and floated figures they do not.

This is the largest open item. Closing it means wiring PDF.js's
`StructTreeLayerBuilder` and accessibility manager, which PDF.js already
supports — it builds a parallel DOM mirroring the structure tree and links it to
the text layer with `aria-owns`. This is tracked work, not a limitation.

### No alternative text for anything we add

Placed images and ink signatures are drawn into the page as graphics with no
textual equivalent, and there is no UI to supply one. The data model has no
field for it. A screen reader sees nothing where a logo or a signature sits.

This is one gap with three faces: a **WCAG 1.1.1** failure for the content we
produce, a **504.2** failure (we cannot author conformant content), and a
**504.3** failure (we never prompt for it). Fixing it means a description field
on image and signature edits, a prompt when placing one, and writing it into the
export.

PDF/UA is explicit that ink signatures are not exempt: *"if a portion of the
appearance of a signature is represented by a graphic, alternative text shall be
provided for that graphic"* (ISO 14289-1 7.13).

### PDF/UA export (504.2.2)

> **504.2.2 PDF Export.** Authoring tools capable of exporting PDF files that
> conform to ISO 32000-1:2008 (PDF 1.7) shall also be capable of exporting PDF
> files that conform to ANSI/AIIM/ISO 14289-1:2016 (PDF/UA-1).

**Folio does not support this, and cannot today.** Two clarifications, because
this provision is widely misread:

- It is **capability**-based. It does not require every PDF we emit to be
  PDF/UA-1, only that we be *capable of* exporting one.
- **508 does not require PDF documents to be PDF/UA.** PDF/UA-1 is referenced by
  exactly one provision — this one. The content requirement is WCAG (E205.4).
  The often-quoted "WCAG 2.0 or, where applicable, ISO 14289-1" line is from the
  2011 *proposed* rule and is not in the final rule; do not cite it.

The blocker is ecosystem-level, not effort-level. Authoring a valid structure
tree into an existing PDF is not possible with our current stack:

- **pdf-lib** has no tagging API at all, and is unmaintained — no release since
  1.17.1 (November 2021). Its issue for tagged-PDF support was closed without
  shipping. The maintained fork `@cantoo/pdf-lib` adds no tagging.
- **pdf.js** reads structure trees well but writes only `Figure` elements, from
  two hardcoded call sites.
- No JavaScript library loads an arbitrary PDF and authors a valid structure tree
  into it.

Realistic routes, neither cheap: a **commercial SDK** (Apryse and comparable
vendors are the only turnkey "load any PDF → emit valid PDF/UA" path), or a
**Rust track** using `krilla` (which genuinely implements `Validator::UA1`, and
is Typst's PDF backend) plus object surgery — but krilla is creation-only and
cannot open an existing PDF, so this is a multi-year direction rather than a
port.

We report this as **Does Not Support** with the above as the remediation path.

### Preservation on save (504.2.1)

> Authoring tools shall, when converting content from one format to another or
> saving content in multiple formats, preserve the information required for
> accessibility to the extent that the information is supported by the
> destination format.

**Partial, and architecturally fragile.** The export pipeline runs
`PDFDocument.saveDocument()` (PDF.js) and then re-loads those bytes into pdf-lib
to stamp edits, signatures and annotations.

- PDF.js's `saveDocument()` is a true **incremental update** — it appends objects
  and a new xref to the original bytes — so it preserves an existing structure
  tree by construction. It cannot damage one.
- pdf-lib fully **re-serializes** the file. A structure tree survives a plain
  `load()` → `save()` because pdf-lib re-writes every object it parsed, but that
  preservation is **incidental rather than designed**, and it breaks outright on
  `copyPages()` (which copies from the page dict and never reaches the catalog's
  `/StructTreeRoot`) and on `form.flatten()` (which orphans struct elements).

Folio uses neither of those two calls today, so tags survive in practice.
In-place text editing (`src/features/textedit/`) is a second, independent
consumer of this same `load()` → `save()` path: every commit re-serializes the
document immediately, ahead of and separate from the export pipeline above. It
avoids `copyPages()` and `form.flatten()` too, so the same reasoning holds, but
a tagged document now goes through pdf-lib's re-serialization once per edit,
not only once at export. The risk is that a future change adds one of those two
calls, in either code path, and silently untags every export. Routing saves
through PDF.js's incremental writer, and keeping pdf-lib for stamping only, is
the durable fix.

What we **do** preserve deliberately: filled form values stay real AcroForm
fields, and highlights and sticky notes are written as **real `/Highlight` and
`/Text` annotations carrying their text in `/Contents`** rather than flattened
into the page graphics. Flattening would look identical and be silent to a
screen reader. Annotated pages also get `/Tabs S`, per ISO 14289-1 7.18.3 — the
requirement annotation-adding software most often misses.

## Support documentation and services (Chapter 6)

Chapter 6 has no exceptions and is the cheapest chapter to satisfy, which is
exactly why it is a common ACR failure.

- **602.2 — accessibility features are listed and explained.**
  [accessibility.md](accessibility.md) documents the keyboard map, focus rules,
  dark schemes, platform-settings support, and assistive-technology
  compatibility. This page documents the gaps.
- **602.3 — electronic documentation conforms to WCAG 2.0 A/AA.** Documentation
  is plain Markdown with real headings, no images carrying meaning without alt
  text, and no color-only distinctions.
- **602.4 — alternate formats on request.** Open an issue or email the
  maintainer; see [SECURITY.md](../SECURITY.md) for contact details.
- **603.2 / 603.3 — support conveys accessibility information and accommodates
  communication needs.** Support runs through GitHub issues (text-based, screen
  reader friendly, no phone call required). Accessibility questions are answered
  from this page and [accessibility.md](accessibility.md).

## Producing an ACR

For US federal procurement, use the **VPAT 2.5Rev (April 2025)**, in either the
**508 edition** or the **INT edition**. A WCAG-only edition is not sufficient,
because 508 covers documentation and support services that WCAG does not reach.
The template is published free by ITI at
<https://www.itic.org/policy/accessibility/vpat>. "VPAT" is the blank template;
once filled in with real test results it is an **ACR**.

Precisely what is and is not mandatory:

- **Conforming** to the Revised 508 Standards is required by statute and
  regulation (29 U.S.C. 794d; 36 CFR 1194.1; **FAR 39.203(a)**), subject to the
  exceptions at FAR 39.204 and exemptions at 39.205.
- **Producing an ACR is not required by any regulation** — "VPAT" and
  "Accessibility Conformance Report" appear nowhere in FAR Subpart 39.2. It is
  required in practice, because agencies impose it through solicitation terms,
  and it becomes contractually binding once you provide it.
- **ITI's template is not mandated** either; it is simply the convention.

The "Voluntary" in VPAT refers to industry's voluntary adoption of a common
reporting format. It does not mean accessibility documentation is optional when
an agency asks for it.

## Validating exports

`veraPDF` is the de facto industry-standard open-source PDF/UA-1 validator, from
the veraPDF Consortium (Open Preservation Foundation and the PDF Association):

```bash
verapdf --flavour ua1 out.pdf
```

Two honest caveats. It implements **only the machine-checkable subset** — for
PDF/UA it explicitly performs only machine-verifiable checks — so a pass is
**necessary but not sufficient**. And it is the designated reference
implementation for PDF/A, *not* for PDF/UA; ISO designates none for 14289-1. In
particular, reading order (Matterhorn 28-001) is human-judged, so a clean
veraPDF run says nothing about whether our annotations are in a sensible place.

## References

- [Revised 508 Standards](https://www.access-board.gov/ict/) — U.S. Access Board
- [Final rule, 82 FR 5790](https://www.access-board.gov/ict/ict-final-rule.pdf)
- [Section508.gov ACR/VPAT FAQ](https://www.section508.gov/sell/acr-vpat-faq/)
- [FAR Subpart 39.2](https://www.acquisition.gov/far/subpart-39.2)
- [ITI VPAT templates](https://www.itic.org/policy/accessibility/vpat)
- [ISO 14289-1 (PDF/UA-1)](https://www.iso.org/standard/64599.html) — note the
  current ISO edition is **2014**; "ANSI/AIIM/ISO 14289-1:2016" is the US
  national adoption of that same text, which is why 508 cites the 2016
  designation
- [Matterhorn Protocol 1.1](https://pdfa.org/download-area/publications/Matterhorn-Protocol-1-1.pdf) — PDF Association
- [veraPDF](https://verapdf.org/)
