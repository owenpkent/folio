import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { PDFDocument, PDFHexString, type PDFPage } from 'pdf-lib';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { downloadBytes } from '@/core/document/downloadBytes';
import { isTauri } from '@/core/document/openDocument';
import { getEngine } from '@/core/pdf';
import { MIN_PDF_BYTES, PDF_HEADER } from '@/core/pdf/pdfHeader';
import { stampAnnotations, useAnnotationStore } from '@/features/annotations';
import { stampEdits, useEditStore } from '@/features/editing';
import { stampOcrLayer, useOcrStore } from '@/features/ocr';
import { useSignatureStore, type Signature } from '@/features/signatures';
import { useDocumentStore } from '@/state/documentStore';

/**
 * Produce the final PDF bytes. PDF.js writes any filled form values, then
 * pdf-lib is loaded once to stamp placed edits (text boxes + images),
 * signatures, and review annotations onto the pages. Crypto signing (if any)
 * wraps this result last, in the signing feature.
 */
export async function exportDocument(): Promise<Uint8Array> {
  const base = await getEngine().saveDocument();
  const edits = useEditStore.getState().edits;
  const signatures = useSignatureStore.getState().signatures;
  const ocrPages = Object.values(useOcrStore.getState().pages);
  const annotations = useAnnotationStore.getState().annotations;
  if (
    edits.length === 0 &&
    signatures.length === 0 &&
    ocrPages.length === 0 &&
    annotations.length === 0
  ) {
    return base;
  }

  const pdf = await PDFDocument.load(base);
  // OCR text goes down first (invisible, underneath), then visible edits, then
  // signatures on top.
  if (ocrPages.length > 0) await stampOcrLayer(pdf, ocrPages);
  if (edits.length > 0) await stampEdits(pdf, edits);
  if (signatures.length > 0) await stampSignatures(pdf, signatures);
  // Highlights and notes are real PDF annotations rather than stamped graphics,
  // so drawing order does not apply to them.
  if (annotations.length > 0) stampAnnotations(pdf, annotations);
  // Everything staged above is now flattened into the page bytes, so this is a
  // new document, not just an edited copy of the source. Left alone, pdf-lib
  // carries the source trailer's /ID through save() unchanged, which means the
  // export would keep the exact fingerprint PDF.js used to key the SOURCE
  // document's sidecar (signatures, edits, OCR text, annotations, all kept in
  // localStorage by fingerprint). Reopening the export would then load that
  // pre-bake sidecar again and paint it on top of content that is already in
  // the page, doubling everything. A fresh /ID breaks that inheritance so a
  // reopened export starts with no sidecar of its own.
  assignFreshDocumentId(pdf);
  return pdf.save();
}

/**
 * Mint a brand new trailer /ID so a baked export gets its own PDF.js
 * fingerprint instead of inheriting the source document's. Both halves are
 * replaced: ISO 32000-1 14.4 makes the first half a permanent identifier tied
 * to the file's original creation and the second one a per-update value, and
 * flattening overlay content produces what is effectively a new document
 * rather than another revision of the source, so preserving the first half
 * would carry over an identity that no longer describes these bytes. Only
 * call this once something has
 * actually been baked in; see the pass-through guard at the top of
 * exportDocument, which returns before pdf-lib is even loaded when there is
 * nothing to stamp.
 */
function assignFreshDocumentId(pdf: PDFDocument): void {
  pdf.context.trailerInfo.ID = pdf.context.obj([
    PDFHexString.of(randomIdHalf()),
    PDFHexString.of(randomIdHalf()),
  ]);
}

/** A random 16-byte value, hex-encoded, for one half of a trailer /ID pair. */
function randomIdHalf(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function stampSignatures(pdf: PDFDocument, signatures: Signature[]): Promise<void> {
  const pages: PDFPage[] = pdf.getPages();

  for (const sig of signatures) {
    const page = pages[sig.pageNumber - 1];
    if (!page) continue;
    const png = await pdf.embedPng(sig.dataUrl);
    const { width: pw, height: ph } = page.getSize();
    const w = sig.rect.width * pw;
    const h = sig.rect.height * ph;
    const x = sig.rect.x * pw;
    // Normalized rects are top-left origin; PDF space is bottom-left.
    const y = ph - sig.rect.y * ph - h;
    page.drawImage(png, { x, y, width: w, height: h });
  }
}

/**
 * Save back to the file the document was opened from (desktop only). Falls
 * back to Save-a-copy when there is no writable origin: browser builds,
 * fetched URLs, and drag-dropped browser Files all open without a path.
 */
export async function saveDocumentInPlace(): Promise<void> {
  const { info, status, sourcePath } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return;

  if (!isTauri() || !sourcePath) {
    await saveDocumentToFile();
    return;
  }

  const bytes = await exportForSave();
  if (!bytes) return;
  try {
    await writeDocument(sourcePath, bytes);
    pushToast('Saved', 'success');
    announce(`Saved ${info.name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Write failed';
    announce(`Could not save the document: ${message}`, true);
    pushToast('Could not save the document', 'error');
  }
}

/** Export the filled/signed document and save it as a copy (dialog or download). */
export async function saveDocumentToFile(): Promise<void> {
  const { info, status } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return;

  const bytes = await exportForSave();
  if (!bytes) return;

  const base = info.name.replace(/\.pdf$/i, '');
  const suffix =
    useSignatureStore.getState().signatures.length > 0
      ? 'signed'
      : useEditStore.getState().edits.length > 0
        ? 'edited'
        : 'filled';
  await saveBytes(bytes, `${base} (${suffix}).pdf`);
}

/**
 * Hand raw PDF bytes to the Rust `write_document` command.
 *
 * The bytes are the *entire* invoke payload, which is what makes Tauri ship
 * them as an `application/octet-stream` body -- the write-direction mirror of
 * `read_document` returning an `ipc::Response`. Nesting the array inside an
 * arguments object instead (`{ path, contents }`) is the cliff this used to be
 * on: Tauri expands a nested `Uint8Array` with `Array.from`, so a 50MB PDF
 * became a 50-million-element array serialized into a ~150MB JSON string, built
 * on the UI thread every time the user hit Save.
 *
 * A raw body leaves no room for a sibling named argument, so the destination
 * path travels as a header, percent-encoded because header values are ASCII
 * only (a path under `C:\Users\Ömer\` would otherwise be rejected by the Rust
 * side) and because encoding removes any CR/LF header-injection surface.
 *
 * `headers` is a plain object literal on purpose: the postMessage fallback path
 * JSON-stringifies the options, and a `Headers` instance serializes to `{}`,
 * which would silently drop the path.
 */
async function writeDocument(path: string, bytes: Uint8Array): Promise<void> {
  await invoke('write_document', bytes, {
    headers: { 'Folio-Path': encodeURIComponent(path) },
  });
}

/**
 * Reject bytes that cannot be a document before they are written anywhere.
 *
 * Saving in place is an atomic rename swap on the Rust side, so the write does
 * not leave a partial file behind, but it does leave *these* bytes as the only
 * copy: an empty or truncated payload replaces the user's document and there is
 * nothing to recover from. Nothing upstream guarantees a non-empty result -- a
 * stamping bug, an engine that returns before it has anything, or a future
 * refactor that swallows an error can all hand back zero bytes -- so this is
 * checked here rather than assumed.
 *
 * The header check is deliberately strict about offset 0. Readers tolerate junk
 * before `%PDF-`, but this is validating our own output, not a file someone
 * else wrote, and everything we write puts the header first.
 */
function isPlausiblePdf(bytes: Uint8Array): boolean {
  if (bytes.length < MIN_PDF_BYTES) return false;
  return PDF_HEADER.every((byte, i) => bytes[i] === byte);
}

/** The message shown (and announced) when a save is refused as unsafe. */
const NOT_A_PDF =
  'the export produced no usable PDF data, so nothing was written. Your document is unchanged.';

/** Run {@link exportDocument}, surfacing failures as a toast; null on failure. */
async function exportForSave(): Promise<Uint8Array | null> {
  try {
    const bytes = await exportDocument();
    // Throwing rather than returning null keeps the reporting in one place:
    // the user gets the same visible toast and announcement a failed export
    // gets, instead of Save appearing to do nothing at all.
    if (!isPlausiblePdf(bytes)) throw new Error(NOT_A_PDF);
    return bytes;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    announce(`Could not prepare the document: ${message}`, true);
    pushToast('Could not save the document', 'error');
    return null;
  }
}

/** Save raw PDF bytes via a native dialog (desktop) or a download (browser). */
export async function saveBytes(bytes: Uint8Array, suggested: string): Promise<boolean> {
  // Repeated from exportForSave because this is the last gate before a write
  // and not every caller comes through there: the signing flow hands over
  // bytes that went out to @signpdf and back.
  if (!isPlausiblePdf(bytes)) {
    announce(`Could not save the document: ${NOT_A_PDF}`, true);
    pushToast('Could not save the document', 'error');
    return false;
  }

  try {
    if (isTauri()) {
      const path = await save({
        defaultPath: suggested,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!path) return false;
      // Write through the Rust `write_document` command (mirrors read_document)
      // so no broad fs:allow-write-file capability scope is needed.
      await writeDocument(path, bytes);
      pushToast('Saved', 'success');
      announce(`Saved ${suggested}`);
      return true;
    }
    downloadBytes(bytes, suggested);
    announce(`Downloaded ${suggested}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Write failed';
    announce(`Could not save the document: ${message}`, true);
    pushToast('Could not save the document', 'error');
    return false;
  }
}

let registered = false;

/** Register export/save commands. Idempotent. */
export function registerExportCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'file.save',
    title: 'Save',
    category: 'File',
    keybinding: 'Mod+S',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => saveDocumentInPlace(),
  });

  commandRegistry.register({
    id: 'file.saveAs',
    title: 'Save a copy…',
    category: 'File',
    keybinding: 'Mod+Shift+S',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => saveDocumentToFile(),
  });
}
