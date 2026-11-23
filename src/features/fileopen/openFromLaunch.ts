import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { pushToast } from '@/components/common';
import { isTauri, readPath } from '@/core/document/openDocument';
import { takeResumeDocument } from '@/features/updates';
import { loadSource } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';

/**
 * Read a PDF path from disk and load it into the viewer.
 *
 * @param page Scroll here once loaded. Only the post-update resume passes it;
 *   an OS-handed file has no page to return to, so it gets the remembered
 *   reading position instead. `loadSource` applies it after the page count is
 *   known, because `goToPage` clamps to it.
 * @returns Whether a document is now open, so a caller offering a file (the
 *   start screen's Continue) can tell when to stop offering it.
 * @param silent Log a failure instead of toasting it. A file the OS handed
 *   over was asked for a moment ago, so an error about it belongs on screen.
 *   The post-update resume was not asked for by anyone: greeting the reader
 *   with a red toast about a document they never opened -- because it lived on
 *   a share, or a drive that is not plugged in, or was synced away since -- is
 *   noise about a convenience that simply did not happen.
 */
export async function openPath(
  path: string,
  { page, silent = false }: { page?: number; silent?: boolean } = {},
): Promise<boolean> {
  try {
    const source = await readPath(path);
    // The page and silence go to loadSource, which announces once and lets an
    // explicit page win over the remembered reading position.
    await loadSource(source, { page, silent });
    // Resolving is not the same as loading: loadSource catches its own
    // failures, records them on the document store, and returns normally. On a
    // file whose bytes read fine but whose PDF structure does not parse, going
    // on from here would jump a zero-page document to page 7 and announce
    // "Opened statement.pdf" over the viewer's own failure message.
    if (useDocumentStore.getState().status !== 'ready') return false;
    return true;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (silent) console.warn('[fileopen] could not reopen', path, messageText);
    else pushToast(`Could not open the PDF: ${messageText}`, 'error');
    return false;
  }
}

/**
 * Load a PDF the OS handed to Folio as the default viewer (desktop only).
 *
 * Three paths, the first two mirroring the `folio://` deep-link handling in
 * `../deeplink`:
 * - Cold start: Folio was launched with a file (double-click). The Rust side
 *   captured the path from argv; we consume it once via `take_launch_file`.
 * - Already running: a second launch forwards the file to this window as a
 *   `folio:open-pdf` event (see the single-instance / macOS `Opened` handlers).
 * - Finishing an update: the restart that installs a new version is one Folio
 *   asked for, not one the user chose, so it puts back the document that was
 *   open before it. See ../updates/resumeAfterUpdate.
 *
 * Returns a cleanup function that detaches the event listener.
 */
export async function registerFileOpen(): Promise<() => void> {
  if (!isTauri()) return () => {};

  // Read before the launch-file check, and unconditionally: the note is a
  // one-shot about a single restart, so it has to be cleared even on the runs
  // that end up ignoring it, or it would reopen on every launch thereafter.
  const resume = takeResumeDocument();

  let launchPath: string | null = null;
  try {
    launchPath = await invoke<string | null>('take_launch_file');
  } catch {
    // No launch file (normal), or the command is unavailable in dev.
  }

  try {
    // A file from the OS wins: the user picked that one just now, where the
    // note only records what happened to be open before the restart.
    if (launchPath) await openPath(launchPath);
    else if (resume) await openPath(resume.path, { page: resume.page, silent: true });
  } finally {
    // Launch handling has settled: from here on, an empty viewer really means
    // "no document", so the splash may show its open-a-document controls.
    useDocumentStore.getState().setBooted();
  }

  try {
    return await listen<string>('folio:open-pdf', (event) => {
      void openPath(event.payload);
    });
  } catch {
    return () => {};
  }
}
