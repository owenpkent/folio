import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common';
import { isTauri, readPath } from '@/core/document/openDocument';
import { loadSource } from '@/state/actions';

/** Read a PDF path from disk and load it into the viewer, toasting on failure. */
async function openPath(path: string): Promise<void> {
  try {
    const source = await readPath(path);
    await loadSource(source);
    announce(`Opened ${source.name}`);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    pushToast(`Could not open the PDF: ${messageText}`, 'error');
  }
}

/**
 * Load a PDF the OS handed to Folio as the default viewer (desktop only).
 *
 * Two paths, mirroring the `folio://` deep-link handling in `../deeplink`:
 * - Cold start: Folio was launched with a file (double-click). The Rust side
 *   captured the path from argv; we consume it once via `take_launch_file`.
 * - Already running: a second launch forwards the file to this window as a
 *   `folio:open-pdf` event (see the single-instance / macOS `Opened` handlers).
 *
 * Returns a cleanup function that detaches the event listener.
 */
export async function registerFileOpen(): Promise<() => void> {
  if (!isTauri()) return () => {};

  try {
    const path = await invoke<string | null>('take_launch_file');
    if (path) await openPath(path);
  } catch {
    // No launch file (normal), or the command is unavailable in dev.
  }

  try {
    return await listen<string>('folio:open-pdf', (event) => {
      void openPath(event.payload);
    });
  } catch {
    return () => {};
  }
}
