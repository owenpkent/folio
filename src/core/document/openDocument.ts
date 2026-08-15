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

/**
 * The outcome of reading a batch of picked or dropped files: everything that
 * read successfully, plus the names of the ones that did not.
 *
 * Partial success is the whole point of the shape. `Promise.all` rejects on
 * the first failure and discards every result that had already resolved, so
 * one locked or permission-denied file among several used to take the entire
 * batch down with it -- the opposite of what the call sites' own comments
 * claimed they did.
 */
export interface BatchRead {
  sources: BytesDocumentSource[];
  /** Display names of the files that could not be read, in the order picked. */
  failed: string[];
}

/**
 * Read every item, keeping whatever succeeds. Never rejects: a read that
 * throws contributes its name to {@link BatchRead.failed} instead.
 */
async function readBatch<T>(
  items: T[],
  read: (item: T) => Promise<BytesDocumentSource>,
  nameOf: (item: T) => string,
): Promise<BatchRead> {
  const settled = await Promise.allSettled(items.map((item) => read(item)));
  const sources: BytesDocumentSource[] = [];
  const failed: string[] = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') sources.push(result.value);
    else failed.push(nameOf(items[i]));
  });
  return { sources, failed };
}

/** Read PDFs from absolute paths (desktop drag-and-drop, native picker). */
export function readPathBatch(paths: string[]): Promise<BatchRead> {
  return readBatch(paths, readPath, basename);
}

/** Read PDFs from browser File objects (HTML5 drop, file-input fallback). */
export function readFileBatch(files: File[]): Promise<BatchRead> {
  return readBatch(files, sourceFromFile, (file) => file.name);
}

/**
 * The message to show when part of a batch could not be read. Shared so the
 * drop paths and the picker path word a partial failure the same way.
 */
export function describeUnreadable(failed: string[]): string {
  if (failed.length === 1) return `Could not read "${failed[0]}"`;
  return `Could not read ${failed.length} files: ${failed.join(', ')}`;
}

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
 * per pick. Returns an empty batch on cancel rather than null: every caller
 * already treats "picked nothing" as a no-op, and a batch keeps that a
 * single length check instead of a null check plus an empty-array check.
 *
 * One unreadable file does not lose the rest: see {@link BatchRead}.
 */
export async function pickAndReadDocuments(): Promise<BatchRead> {
  if (isTauri()) {
    const selected = await open({
      multiple: true,
      directory: false,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (!selected) return { sources: [], failed: [] };
    const paths = Array.isArray(selected) ? selected : [selected];
    return readPathBatch(paths);
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

// Both pickers below hand their async work to `resolve`/`reject` rather than
// awaiting inside the listener. An `async` listener that throws takes its
// rejection nowhere -- the executor's `resolve` is never reached and there is
// no `reject` in scope to reach either -- so the returned Promise stays
// pending forever instead of failing. The caller then never returns from its
// `await`, and its own try/catch never runs.
function pickViaFileInput(): Promise<DocumentSource | null> {
  return new Promise((resolve, reject) => {
    const input = createHiddenFileInput(false);
    const cleanup = () => input.remove();

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      sourceFromFile(file).then(resolve, reject);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    input.click();
  });
}

function pickViaFileInputMultiple(): Promise<BatchRead> {
  return new Promise((resolve) => {
    const input = createHiddenFileInput(true);
    const cleanup = () => input.remove();

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      cleanup();
      // readFileBatch never rejects, so there is nothing here that could
      // leave this Promise unsettled.
      resolve(readFileBatch(files));
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve({ sources: [], failed: [] });
    });
    input.click();
  });
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || 'Untitled.pdf';
}
