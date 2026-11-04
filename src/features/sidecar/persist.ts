import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common/toastStore';

/**
 * Every per-document sidecar store (annotations, signatures, placed edits,
 * OCR text) writes through to localStorage on each change. The browser can
 * refuse the write, most often for quota: a signature is a PNG data URL, and
 * a long document's OCR text is large. Each store used to swallow that, so
 * what the user saw on the page and what would come back on the next open
 * silently parted ways: a signature that looked saved was gone on reopen, and
 * a page operation whose remap could not be persisted left storage holding
 * the OLD page numbers, so on reopen everything sat on the wrong pages.
 *
 * The in-memory state is still the right thing to keep (the page is correct,
 * and a saved copy bakes the placements in), so this does not undo anything;
 * it tells the user, once per document rather than on every keystroke.
 */

const MESSAGE =
  "Could not store this file's edits: the browser's storage is full. " +
  'They stay until the file is closed; save a copy to keep them.';

/** Documents already warned about, so a burst of edits yields one toast. */
const warned = new Set<string>();

/**
 * Write one sidecar entry, telling the user the first time a document's
 * writes start failing. Returns whether it was written.
 */
export function persistSidecar(fingerprint: string, key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    if (!warned.has(fingerprint)) {
      warned.add(fingerprint);
      pushToast(MESSAGE, 'error');
      announce(MESSAGE, true);
    }
    return false;
  }
}

/** Forget which documents were warned about. For tests. */
export function resetPersistWarnings(): void {
  warned.clear();
}
