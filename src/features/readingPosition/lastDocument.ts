import { isResumablePath } from '@/features/updates/resumeAfterUpdate';

/**
 * The one document the start screen offers to continue. Unlike the per-file
 * positions this does hold a path and a name, because opening it needs both;
 * that is why there is only ever one, and why closing a document leaves it be
 * (it is exactly what the next launch wants).
 */
const KEY = 'folio.lastDocument';

export interface LastDocument {
  path: string;
  name: string;
  page: number;
}

/** A file name is short; anything longer is not one of ours. */
const MAX_NAME = 512;

function isValid(path: unknown, name: unknown, page: unknown): boolean {
  return (
    typeof path === 'string' &&
    // The same rule the update resume applies: a path that is not safe to hand
    // to the file read later is not written now, and not trusted on the way back.
    isResumablePath(path) &&
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_NAME &&
    typeof page === 'number' &&
    Number.isInteger(page) &&
    page >= 1
  );
}

export function writeLastDocument(note: LastDocument): void {
  if (!isValid(note.path, note.name, note.page)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(note));
  } catch {
    // A convenience: see store.ts.
  }
}

/** The note, or null if absent or anything about it fails validation. Never throws. */
export function readLastDocument(): LastDocument | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const note: unknown = JSON.parse(raw);
    if (typeof note !== 'object' || note === null) return null;
    const { path, name, page } = note as Record<string, unknown>;
    if (!isValid(path, name, page)) return null;
    return { path: path as string, name: name as string, page: page as number };
  } catch {
    return null;
  }
}

export function clearLastDocument(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do.
  }
}
