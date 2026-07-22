# Forms and signatures

Folio can fill interactive PDF forms and place signatures, then save a copy with
everything baked in. This page explains how both work today and what is planned.

Signing is delivered in two phases, both now available:

1. **Ink / visual signatures.** Draw, type, or upload a signature and place it on
   the page. This is what most people mean by "sign this PDF."
2. **Cryptographic digital signatures.** Certificate-based (PKCS#7 detached)
   signing, like Acrobat's "Sign with a Digital ID," plus basic verification of
   existing signatures. See [Cryptographic digital signatures](#cryptographic-digital-signatures).

## Filling forms

PDFs with an AcroForm (text fields, checkboxes, radio buttons, dropdowns, list
boxes) render as real, interactive fields directly over the page.

- Rendering is handled by PDF.js. For each page the engine calls
  `renderAnnotationLayer(pageNumber, container, { scale, signal })`, which builds
  the PDF.js annotation layer with `renderForms: true`. The fields are native
  HTML inputs, so they are focusable, keyboard-operable, and exposed to screen
  readers.
- Because those inputs already display each field's value, the page raster must
  leave the widgets out, which is what `renderPage({ overlayForms: true })` does.
  Otherwise PDF.js paints the value into the canvas as well and the two copies
  show through each other as doubled text. Thumbnails have no input overlay, so
  they omit the flag and keep the values in the raster.
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
`file.save` command. Folio produces the output in two stages (see
`src/features/export/saveDocument.ts`):

1. PDF.js `saveDocument()` writes the filled form values into a fresh PDF.
2. If there is anything else to bake, [pdf-lib](https://pdf-lib.js.org) loads
   those bytes once and stamps, in order: the invisible OCR text layer, placed
   edits (text boxes and images), signature images, and review annotations
   (highlights and sticky notes, written as real `/Highlight` and `/Text`
   annotations, not flattened graphics). When none of those are present, the
   step-1 bytes are returned as-is.

Text edited in place with the **Edit text** tool (see
[editing-and-ocr.md](editing-and-ocr.md#editing-existing-text)) is already part
of the document by this point: each in-place edit commits immediately rather
than waiting for a save, so step 1's fresh PDF already contains it alongside
the filled form values.

Where the result goes depends on the command. **Save** (`Ctrl/Cmd + S`) writes
it back to the file the document was opened from in the desktop app; the write
is atomic (a temp file next to the target, renamed over it), so a failed save
never corrupts the original. When there is no writable origin (the browser
build, fetched URLs, browser drag-and-drop), Save falls back to **Save a
copy…** (`Ctrl/Cmd + Shift + S`), which writes to whatever path you pick in
the native Save dialog (through the Tauri `dialog` plugin plus the Rust
`write_document` command, so the frontend needs no broad filesystem
capability) or downloads in the browser dev build. The suggested copy filename
is the original name with a `(filled)`, `(edited)`, or `(signed)` suffix.

## Cryptographic digital signatures

Beyond visual signatures, Folio can apply a real cryptographic signature (PKCS#7
detached) that PDF readers, including Acrobat, recognize under "Signatures." Open
it from the toolbar (the shield icon), the Signatures panel ("Digitally sign"),
or the `sign.digitallySign` command.

### Signing identities

A signing identity is a certificate plus its private key, held in a passphrase
protected PKCS#12 (`.p12` / `.pfx`). You can:

- **Import** an existing `.p12` from a certificate authority or your organization
  (enter its passphrase to unlock it).
- **Create a self-signed** identity in the app (name, optional organization, and
  a passphrase). Self-signed certificates are fine for personal use and testing;
  they verify as a valid signature from an untrusted issuer until the recipient
  chooses to trust your certificate.

Saved identities are kept in local storage as their passphrase-protected `.p12`
(the passphrase itself is never stored). You re-enter the passphrase each time
you sign.

### Signing

"Sign and save" first prepares the document (filling forms and stamping any
visual signatures), then computes the CMS SignedData over the whole file with
[@signpdf](https://github.com/vbuch/node-signpdf) and node-forge and writes a
`(signed)` copy. Because a digital signature covers the entire file, signing is
the last step: any later edit invalidates it, so Folio always saves to a new file
rather than modifying the open one.

### Verifying signatures

When you open a signed PDF, the Signatures panel lists each digital signature
with the signer's name (from the certificate), the signing time, and whether the
document changed after signing. That last check is a reliable tamper signal: it
is derived from the signed byte range, so appended edits are detected. Full
certificate-chain trust validation and CMS digest verification are not yet
performed (see Limitations).

### Where the crypto runs, and security

Signing currently runs in the app's front-end (WebView) using the mature,
open-source @signpdf and node-forge libraries. This is portable and verifiable,
but private-key material passes through the WebView. Moving signing into the Rust
backend with OS-keychain-backed key storage is planned; the code is isolated
behind `src/features/signing/` so that change will not affect the rest of the
app.

## Accessibility

- Form fields are native inputs: full keyboard operation and screen-reader
  labels come from the PDF.
- The signature dialog is a focus-trapped modal, dismissible with `Escape`.
- Placed signatures can be deleted with a keyboard-focusable button. Dragging and
  resizing are pointer interactions today; keyboard nudge and resize are planned.

## Limitations (current)

- Cryptographic signing uses PKCS#7 detached signatures. Certificate-chain trust
  validation, full CMS digest verification, PAdES-specific profiles, and embedded
  timestamps (RFC 3161) are not yet implemented; verification reports the signer,
  signing time, and whether the file changed after signing.
- Signing runs in the WebView today; a Rust/OS-keychain backend is planned.
- Visual-signature stamping assumes unrotated pages (rotation support is planned).

## Roadmap

- Certificate-chain trust validation and full CMS digest verification, with a
  trust panel.
- Embedded timestamps (RFC 3161) and PAdES profiles.
- Move signing to a Rust backend with OS-keychain-backed key storage.
- Optional flattening of form fields on export.
- Creating and editing form fields (not just filling them).
- Keyboard placement and rotation-aware stamping.

See [ROADMAP.md](../ROADMAP.md) for how this fits the broader plan.
