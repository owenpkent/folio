/**
 * Where the reader was in each document, so reopening one picks up there.
 *
 * Keyed by the content key (a SHA-256 of the bytes, see
 * core/document/contentKey.ts), with digests of the trailer /ID and the path
 * as fallbacks (see aliases.ts), and never a plaintext path or file name. This
 * list outlives the documents it describes, and a history of what someone read
 * has no business sitting in storage under names they would recognise.
 *
 * It is a convenience, unlike the sidecar stores: losing it costs a scroll, so
 * a failed write is dropped without a toast (compare features/sidecar/persist).
 */

import { clampScale, DEFAULT_FIT_MODE, FIT_MODES, type FitMode } from '@/state/viewerStore';

import type { PositionKeys } from './aliases';

const KEY = 'folio.readingPositions';
const VERSION = 1;

/** Past this the oldest entries go; 200 documents is far more than anyone returns to. */
export const MAX_ENTRIES = 200;

/** Where the reader was: the page at the top, and how it was zoomed. */
export interface ReadingPosition {
  page: number;
  scale: number;
  fitMode: FitMode;
}

interface Entry extends ReadingPosition {
  at: number;
  /** Digest of the trailer /ID; see aliases.ts. Optional: a bad one is dropped, not the entry. */
  id?: string;
  /** Digest of the normalised path. */
  path?: string;
}

/** What contentKey produces: SHA-256, lower-case hex. */
const FINGERPRINT = /^[0-9a-f]{64}$/;

export function isContentKey(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT.test(value);
}

/** A digest or nothing: a malformed alias must not take the entry down with it. */
const alias = (value: unknown): string | undefined => (isContentKey(value) ? value : undefined);

/**
 * localStorage is not a trust boundary (see isResumablePath in
 * features/updates/resumeAfterUpdate), so every field is checked on the way
 * back in and a bad entry is dropped on its own; a bad root drops everything.
 * Never throws.
 */
function read(): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return entries;
    const root: unknown = JSON.parse(raw);
    if (typeof root !== 'object' || root === null || Array.isArray(root)) return entries;
    const { v, entries: stored } = root as { v?: unknown; entries?: unknown };
    if (v !== VERSION) return entries;
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return entries;
    for (const [fingerprint, entry] of Object.entries(stored)) {
      if (!isContentKey(fingerprint)) continue;
      if (typeof entry !== 'object' || entry === null) continue;
      const { page, scale, fitMode, at, id, path } = entry as Record<string, unknown>;
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) continue;
      if (typeof scale !== 'number' || !Number.isFinite(scale)) continue;
      if (!FIT_MODES.includes(fitMode as FitMode)) continue;
      if (typeof at !== 'number' || !Number.isFinite(at)) continue;
      // Through the viewer's own clamp, so a hand-edited 1e9 cannot ask for a
      // zoom the controls themselves would never reach.
      entries.set(fingerprint, {
        page,
        scale: clampScale(scale),
        fitMode: fitMode as FitMode,
        at,
        id: alias(id),
        path: alias(path),
      });
    }
  } catch {
    // Unparseable or storage unavailable: no remembered positions.
  }
  return entries;
}

function write(entries: Map<string, Entry>): void {
  try {
    if (entries.size > MAX_ENTRIES) {
      const newestFirst = [...entries].sort((a, b) => b[1].at - a[1].at);
      entries = new Map(newestFirst.slice(0, MAX_ENTRIES));
    }
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, entries: Object.fromEntries(entries) }));
  } catch {
    // Quota, private mode, storage disabled: the position is not worth a toast.
  }
}

/** A remembered position, and which identity it was found by. */
export interface FoundPosition extends ReadingPosition {
  via: 'hash' | 'id' | 'path';
}

/**
 * The remembered position for a document, or null when there is none worth
 * resuming. The one place that decides which keys to try, in order: the exact
 * content hash; then the most recent entry with the same trailer /ID (the file
 * was re-saved by another program); then the most recent with the same path
 * (the file was replaced by one with a different /ID). A page past the end of
 * this document rules a match out rather than being clamped: it is evidence
 * the entry is about something else.
 */
export function findPosition(keys: PositionKeys, numPages: number): FoundPosition | null {
  const entries = read();
  const usable = (entry: Entry | undefined): entry is Entry =>
    entry !== undefined && entry.page <= numPages;
  const newest = (match: (entry: Entry) => boolean): Entry | undefined => {
    let best: Entry | undefined;
    for (const entry of entries.values()) {
      if (match(entry) && usable(entry) && (!best || entry.at > best.at)) best = entry;
    }
    return best;
  };
  const exact = isContentKey(keys.fingerprint) ? entries.get(keys.fingerprint) : undefined;
  const found: [Entry | undefined, FoundPosition['via']][] = [
    [usable(exact) ? exact : undefined, 'hash'],
    [keys.idKey ? newest((e) => e.id === keys.idKey) : undefined, 'id'],
    [keys.pathKey ? newest((e) => e.path === keys.pathKey) : undefined, 'path'],
  ];
  for (const [entry, via] of found) {
    if (!entry) continue;
    // A reset marker (see setReadingPosition) settles it: the reader went back
    // to the top, so there is nothing to resume, and the older entries further
    // down this list must not be tried in its place.
    if (isReset(entry)) return null;
    return { page: entry.page, scale: entry.scale, fitMode: entry.fitMode, via };
  }
  return null;
}

/** The top of the document at the default fit: nothing to resume. */
function isReset(position: ReadingPosition): boolean {
  return position.page === 1 && position.fitMode === DEFAULT_FIT_MODE;
}

/**
 * Remember a position under the content hash, with the aliases it can later
 * be found by. The top of the document at the default fit is not a position
 * worth keeping: there is nothing to resume. The top at any other zoom is,
 * since the zoom is the point.
 *
 * Going back to the top deletes this document's own entry and no other. An
 * entry that shares an alias may be an older copy of this document, but it may
 * as well be a different one: independently filled copies of one template
 * share a trailer /ID, and each has its own place. Deleting it would erase
 * another file's exact position.
 *
 * Those entries would still be found by the alias fallback and resume a page
 * the reader has since left, so when any exist this document's entry is kept
 * as a reset marker instead of deleted: page 1 at the default fit, newer than
 * they are. findPosition treats that as "nothing to resume" and stops there.
 * With no such entry there is nothing to shadow, and deleting keeps the list
 * small.
 */
export function setReadingPosition(keys: PositionKeys, position: ReadingPosition): void {
  const { fingerprint, idKey, pathKey } = keys;
  const { page, scale, fitMode } = position;
  if (!isContentKey(fingerprint) || !Number.isInteger(page) || page < 1) return;
  if (!Number.isFinite(scale) || !FIT_MODES.includes(fitMode)) return;
  const entries = read();
  const next: Entry = {
    page,
    scale: clampScale(scale),
    fitMode,
    at: Date.now(),
    id: alias(idKey),
    path: alias(pathKey),
  };
  if (isReset(position)) {
    const shadowsAnother = [...entries].some(
      ([key, entry]) =>
        key !== fingerprint &&
        ((next.id !== undefined && entry.id === next.id) ||
          (next.path !== undefined && entry.path === next.path)),
    );
    if (shadowsAnother) entries.set(fingerprint, next);
    else if (!entries.delete(fingerprint)) return;
  } else {
    entries.set(fingerprint, next);
  }
  write(entries);
}
