import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { PDFDocument } from 'pdf-lib';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { isTauri } from '@/core/document/openDocument';
import { getEngine } from '@/core/pdf';
import { useSignatureStore, type Signature } from '@/features/signatures';
import { useDocumentStore } from '@/state/documentStore';

/**
 * Produce the final PDF bytes: PDF.js writes any filled form values, then
 * pdf-lib stamps the placed signatures onto the pages.
 */
export async function exportDocument(): Promise<Uint8Array> {
  const base = await getEngine().saveDocument();
  const signatures = useSignatureStore.getState().signatures;
  if (signatures.length === 0) return base;
  return stampSignatures(base, signatures);
}

async function stampSignatures(bytes: Uint8Array, signatures: Signature[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages();

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

  return pdf.save();
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
  const suffix = useSignatureStore.getState().signatures.length > 0 ? 'signed' : 'filled';
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
      await writeFile(path, bytes);
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
