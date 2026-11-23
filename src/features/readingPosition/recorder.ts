import { contentKey } from '@/core/document/contentKey';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { pathAlias, type PositionKeys } from './aliases';
import { writeLastDocument } from './lastDocument';
import { isContentKey, setReadingPosition } from './store';

/** Scrolling fires currentPage on every page boundary; storage waits for a pause. */
const DEBOUNCE_MS = 500;

/**
 * The document whose position is being recorded. Null whenever nothing should
 * be: between documents, and while a load is resetting the viewer. That is the
 * guard against the transient page 1 from viewer.reset() overwriting the stored
 * position: the load only starts tracking after it has restored.
 */
let active: PositionKeys | null = null;
let pending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  let { currentPage, fitMode, scale } = useViewerStore.getState();
  useViewerStore.subscribe((state) => {
    // In a fit mode the scale is derived from the window and changes on every
    // resize; only a hand-picked zoom is the reader's own to remember.
    const changed =
      state.currentPage !== currentPage ||
      state.fitMode !== fitMode ||
      (state.fitMode === 'custom' && state.scale !== scale);
    ({ currentPage, fitMode, scale } = state);
    if (!changed || !active) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flushReadingPosition, DEBOUNCE_MS);
  });
  // The debounce would otherwise lose the last half second on a quit or reload.
  window.addEventListener('pagehide', flushReadingPosition);
}

/** Write the viewer's position under this document, and the start-screen note. */
function record(keys: PositionKeys): void {
  const { currentPage, scale, fitMode } = useViewerStore.getState();
  setReadingPosition(keys, { page: currentPage, scale, fitMode });
  writeNote(currentPage);
}

function writeNote(page: number): void {
  const { sourcePath, info } = useDocumentStore.getState();
  if (sourcePath && info) writeLastDocument({ path: sourcePath, name: info.name, page });
}

/** Write any pending position now, under the document it was read in. */
export function flushReadingPosition(): void {
  clearTimeout(timer);
  timer = undefined;
  if (active && pending) record(active);
  pending = false;
}

/** Start recording the viewer's position under this document. Call after restoring. */
export function startReadingPosition(keys: PositionKeys): void {
  flushReadingPosition();
  active = isContentKey(keys.fingerprint) ? keys : null;
  install();
  // Opening is enough to make this the document to continue, scrolled or not.
  // Only the note: the position itself was just read from storage.
  if (active) writeNote(useViewerStore.getState().currentPage);
}

/** Flush and stop. Call before the stores reset or another document loads. */
export function stopReadingPosition(): void {
  flushReadingPosition();
  active = null;
}

/**
 * Saving rewrites the file, which changes its hash, so the next open would find
 * nothing. Record the current position under the written bytes' key as well.
 */
export async function recordPositionForBytes(
  bytes: Uint8Array,
  path: string | null = null,
  { follow = false }: { follow?: boolean } = {},
): Promise<void> {
  try {
    const fingerprint = await contentKey({ kind: 'bytes', data: bytes });
    if (!fingerprint) return;
    const pathKey = path ? await pathAlias(path) : null;
    const { currentPage, scale, fitMode } = useViewerStore.getState();
    // The same /ID as the document being saved: the written file is that
    // document, so a later fallback by /ID should land on it too.
    const keys: PositionKeys = { fingerprint, idKey: active?.idKey ?? null, pathKey };
    setReadingPosition(keys, { page: currentPage, scale, fitMode });
    // A save in place replaced the file on disk, so reading on from here is
    // reading that file. Left on the as-opened hash, the rest of the session
    // would be filed under bytes that no longer exist, and the next open would
    // match this save-time snapshot exactly and resume at the page it was
    // saved on rather than the page the reader stopped at.
    if (follow && active) active = keys;
  } catch {
    // A convenience; never fail a save over it.
  }
}
