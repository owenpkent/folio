import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { PDFDocument, type PDFPage } from 'pdf-lib';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import { getEngine } from '@/core/pdf';
import { stampEdits, useEditStore } from '@/features/editing';
import { useSignatureStore, type Signature } from '@/features/signatures';
import { useDocumentStore } from '@/state/documentStore';

/**
 * Produce the final PDF bytes. PDF.js writes any filled form values, then
 * pdf-lib is loaded once to stamp placed edits (text boxes + images) and
 * signatures onto the pages, in that order. Crypto signing (if any) wraps this
 * result last, in the signing feature.
 */
export async function exportDocument(): Promise<Uint8Array> {
  const base = await getEngine().saveDocument();
  const edits = useEditStore.getState().edits;
  const signatures = useSignatureStore.getState().signatures;
  if (edits.length === 0 && signatures.length === 0) return base;

  const pdf = await PDFDocument.load(base);
  if (edits.length > 0) await stampEdits(pdf, edits);
  if (signatures.length > 0) await stampSignatures(pdf, signatures);
  return pdf.save();
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

/** Export the filled/signed document and save it as a copy (dialog or download). */
export async function saveDocumentToFile(): Promise<void> {
  const { info, status } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return;

  let bytes: Uint8Array;
  try {
    bytes = await exportDocument();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    announce(`Could not prepare the document: ${message}`, true);
    pushToast('Could not save the document', 'error');
    return;
  }

  const base = info.name.replace(/\.pdf$/i, '');
  const suffix =
    useSignatureStore.getState().signatures.length > 0
      ? 'signed'
      : useEditStore.getState().edits.length > 0
        ? 'edited'
        : 'filled';
  await saveBytes(bytes, `${base} (${suffix}).pdf`);
}

/** Save raw PDF bytes via a native dialog (desktop) or a download (browser). */
export async function saveBytes(bytes: Uint8Array, suggested: string): Promise<boolean> {
  try {
    if (isTauri()) {
      const path = await save({
        defaultPath: suggested,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (!path) return false;
      // Write through the Rust `write_document` command (mirrors read_document)
      // so no broad fs:allow-write-file capability scope is needed.
      await invoke('write_document', { path, contents: Array.from(bytes) });
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

function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh ArrayBuffer-backed view so the type is a valid BlobPart.
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let registered = false;

/** Register export/save commands. Idempotent. */
export function registerExportCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'file.save',
    title: 'Save a copy…',
    category: 'File',
    keybinding: 'Mod+S',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => saveDocumentToFile(),
  });
}
