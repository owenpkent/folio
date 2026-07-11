import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import type { DocumentSource } from '@/core/pdf';

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

/** Read a PDF from an absolute path (used for drag-and-drop in the desktop app). */
export async function readPath(path: string): Promise<DocumentSource> {
  const buffer = await invoke<ArrayBuffer>('read_document', { path });
  return { kind: 'bytes', data: new Uint8Array(buffer), name: basename(path) };
}

/** Build a source from a browser File (drag-and-drop / file input fallback). */
export async function sourceFromFile(file: File): Promise<DocumentSource> {
  const data = new Uint8Array(await file.arrayBuffer());
  return { kind: 'bytes', data, name: file.name };
}

function pickViaFileInput(): Promise<DocumentSource | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf,.pdf';
    // Attach (hidden) so the picker opens reliably across browsers.
    input.style.display = 'none';
    document.body.appendChild(input);
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

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || 'Untitled.pdf';
}
