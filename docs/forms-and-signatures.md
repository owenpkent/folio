# Forms and signatures

Folio can fill interactive PDF forms and place signatures, then save a copy with
everything baked in. This page explains how both work today and what is planned.

Signing is being delivered in two phases:

1. **Ink / visual signatures (shipped).** Draw, type, or upload a signature and
   place it on the page. This is what most people mean by "sign this PDF."
2. **Cryptographic digital signatures (planned).** Certificate-based (PKCS#7 /
   PAdES) signing and verification, like Acrobat's "Sign with a Digital ID."
   See [Roadmap](#roadmap).

## Filling forms

PDFs with an AcroForm (text fields, checkboxes, radio buttons, dropdowns, list
boxes) render as real, interactive fields directly over the page.

- Rendering is handled by PDF.js. For each page the engine calls
  `renderAnnotationLayer(pageNumber, container, scale)`, which builds the PDF.js
  annotation layer with `renderForms: true`. The fields are native HTML inputs,
  so they are focusable, keyboard-operable, and exposed to screen readers.
- Field edits are written into the document's `annotationStorage` (managed by
  PDF.js) as you type or toggle. Nothing is written to disk until you save.
- The field layer sits above the text layer (`z-index: 3`) so fields are
  clickable, while the layer itself is `pointer-events: none` between fields, so
  text selection elsewhere on the page still works.

To detect whether a document has fillable fields, the engine exposes
`hasFormFields()`, and `getPendingEditCount()` reports how many fields have
unsaved edits.

## Signatures

Open the signature dialog from the toolbar (the signature icon) or the
Signatures sidebar tab, or run the `sign.addSignature` command. You can create a
signature three ways:

- **Draw** on a canvas with a mouse, pen, or finger. The drawing is trimmed to
  its ink bounds and exported as a transparent PNG.
- **Type** your name and choose a script, serif, or sans style. The text is
  rendered to a PNG.
- **Upload** a PNG or JPEG image of a signature.

Once created, the signature is placed in the center of the current page. On the
page you can:

- **Drag** it to reposition (drag the image).
- **Resize** it from the corner handle (aspect ratio is preserved).
- **Delete** it with the button that appears on hover, or from the Signatures
  panel.

Signatures are stored per document in a local sidecar (keyed by the PDF
fingerprint), exactly like annotations, so they persist across sessions and
never modify the original file until you save a copy.

### How signatures are stored and coordinates

A signature is `{ pageNumber, dataUrl, rect }`, where `rect` is normalized to the
page (fractions from 0 to 1, top-left origin) so it survives zoom. On save, each
rect is converted to PDF user space (bottom-left origin) when the image is
stamped.

## Saving

Run **Save a copy** (`Ctrl/Cmd + S`), the toolbar Save button, or the
`file.save` command. Folio produces the output in two steps (see
`src/features/export/saveDocument.ts`):

1. PDF.js `saveDocument()` writes the filled form values into a fresh PDF.
2. If any signatures are placed, [pdf-lib](https://pdf-lib.js.org) loads those
   bytes and stamps each signature image onto its page.

The result is written through a native Save dialog in the desktop app (via the
Tauri `dialog` and `fs` plugins) or downloaded in the browser dev build. The
suggested filename is the original name with a `(filled)` or `(signed)` suffix;
the original document is never overwritten.

## Accessibility

- Form fields are native inputs: full keyboard operation and screen-reader
  labels come from the PDF.
- The signature dialog is a focus-trapped modal, dismissible with `Escape`.
- Placed signatures can be deleted with a keyboard-focusable button. Dragging and
  resizing are pointer interactions today; keyboard nudge and resize are planned.

## Limitations (current)

- Signatures are **visual**, not cryptographic. They do not prove identity or
  detect tampering. Cryptographic signing is the next phase.
- Signature stamping assumes unrotated pages (page rotation support is planned).
- Saving requires the destination to be within the user's home directory tree in
  the desktop app (the write capability scope). This will be broadened.

## Roadmap

- Certificate-based digital signatures (PKCS#7 / PAdES) with a Rust signing
  backend and PKCS#12 (`.p12`) import.
- Signature verification and a signatures/trust panel.
- Optional flattening of form fields on export.
- Creating and editing form fields (not just filling them).
- Keyboard placement and rotation-aware stamping.

See [ROADMAP.md](../ROADMAP.md) for how this fits the broader plan.
