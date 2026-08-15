import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import type { DocumentSource } from '@/core/pdf';

/**
 * A document source backed by in-memory bytes, as opposed to a URL. Every
 * path in this module (the native dialog, drag-and-drop, the file input
 * fallback) reads bytes and produces one of these, so callers that only ever
 * go through here -- the combine feature, multi-file drop -- can read `.data`
 * directly instead of re-narrowing the wider `DocumentSource` union each time.
 */
export type BytesDocumentSource = Extract<DocumentSource, { kind: 'bytes' }>;

/** True when running inside the Tauri shell (vs a plain browser dev server). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Show a file picker and read the chosen PDF into memory.
 *
 * In the desktop app this uses the native dialog and reads bytes through the
 * Rust `read_document` command. In a plain browser (useful for `npm run dev`
 * without Tauri) it falls back to a hidden file input.
 */
export async function pickAndReadDocument(): Promise<DocumentSource | null> {
  if (isTauri()) {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    return readPath(selected);
  }
  return pickViaFileInput();
}

/**
 * Show a file picker for multiple PDFs and read them all into memory, in the
 * order chosen. Used by the combine feature, which needs more than one file
 * per pick. Returns an empty array on cancel rather than null: every caller
 * already treats "picked nothing" as a no-op, and an array keeps that a
 * single length check instead of a null check plus an empty-array check.
 */
export async function pickAndReadDocuments(): Promise<BytesDocumentSource[]> {
  if (isTauri()) {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!selected) return [];
    const paths = Array.isArray(selected) ? selected : [selected];
    return Promise.all(paths.map((path) => readPath(path)));
  }
  return pickViaFileInputMultiple();
}

/** Read a PDF from an absolute path (used for drag-and-drop in the desktop app). */
export async function readPath(path: string): Promise<BytesDocumentSource> {
  const buffer = await invoke<ArrayBuffer>('read_document', { path });
  return { kind: 'bytes', data: new Uint8Array(buffer), name: basename(path), path };
}

/** Build a source from a browser File (drag-and-drop / file input fallback). */
export async function sourceFromFile(file: File): Promise<BytesDocumentSource> {
  const data = new Uint8Array(await file.arrayBuffer());
  return { kind: 'bytes', data, name: file.name };
}

/** A hidden, auto-clicked `<input type="file">`, attached so the picker opens reliably across browsers. */
function createHiddenFileInput(multiple: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf,.pdf';
  input.multiple = multiple;
  input.style.display = 'none';
  document.body.appendChild(input);
  return input;
}

function pickViaFileInput(): Promise<DocumentSource | null> {
  return new Promise((resolve) => {
    const input = createHiddenFileInput(false);
    const cleanup = () => input.remove();

    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      cleanup();
      resolve(file ? await sourceFromFile(file) : null);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    input.click();
  });
}

function pickViaFileInputMultiple(): Promise<BytesDocumentSource[]> {
  return new Promise((resolve) => {
    const input = createHiddenFileInput(true);
    const cleanup = () => input.remove();

    input.addEventListener('change', async () => {
      const files = Array.from(input.files ?? []);
      cleanup();
      resolve(await Promise.all(files.map((file) => sourceFromFile(file))));
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve([]);
    });
    input.click();
  });
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || 'Untitled.pdf';
}
