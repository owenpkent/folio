import { create } from 'zustand';

import { announce } from '@/a11y/announcer';
import { pushToast } from '@/components/common/toastStore';
import { storageKey as annotationKey, useAnnotationStore } from '@/features/annotations/store';
import { storageKey as editKey, useEditStore } from '@/features/editing/store';
import { storageKey as ocrKey, useOcrStore } from '@/features/ocr/store';
import { storageKey as signatureKey, useSignatureStore } from '@/features/signatures/store';
import {
  DOCUMENT_MUTATION_BUSY_TITLE,
  useDocumentMutationStore,
} from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';

/**
 * Sidecar state saved by Folio releases up to 0.8.1 was keyed by the PDF.js
 * fingerprint, which two files filled from the same template share (see
 * core/document/contentKey.ts). Those entries are still in localStorage under
 * the old key, and Folio cannot tell which file they really belong to: a
 * signature placed on one W-4 looks identical to one placed on another.
 *
 * So the first time a document turns up with saved state under its old key
 * and nothing under its new one, the user decides. Apply moves the entries
 * under this file's key; Discard deletes them. Either way the old key is
 * gone afterwards, so the next file from the same template opens clean
 * instead of asking again.
 *
 * Only stores with nothing under the new key take a copy. If the user placed
 * something on this file before deciding, that is their own work on this very
 * file and it beats a copy that may belong to a different one.
 *
 * The offer is only good for the page map the file opened with. A page
 * operation renumbers the sidecars under the new key (and leaves an undo
 * snapshot of them that a later undo would write straight back), so the old
 * entries no longer describe this document and the offer is withdrawn: see
 * remapPageState in features/pageops/pageState.ts. The entries themselves stay
 * put, and reopening the file offers them again. Apply also takes the
 * cross-feature lock so it cannot land in the middle of such an operation.
 */

/** Every per-document sidecar, by the function that names its storage key. */
const SIDECARS = [annotationKey, signatureKey, editKey, ocrKey] as const;

export interface LegacySidecar {
  /** The content key the document is open under. */
  fingerprint: string;
  /** The PDF.js fingerprint the old (up to 0.8.1) sidecar is filed under. */
  legacyKey: string;
}

interface LegacySidecarState {
  pending: LegacySidecar | null;
  /**
   * Called by loadSource once the stores are keyed under `fingerprint`. Sets
   * `pending` when some sidecar has state under `legacyKey` and none has any
   * under `fingerprint`; clears it otherwise.
   */
  detect(fingerprint: string, legacyKey: string): void;
  /**
   * Move the old entries under this document's key and reload the stores.
   *
   * All or nothing: every copy has to be written before any old entry is
   * deleted, and a write that fails (localStorage over quota, usually, since
   * both copies have to coexist for a moment) puts back what was written and
   * leaves the offer standing, so the user can free space or discard instead.
   */
  apply(): void;
  /** Delete the old entries. */
  discard(): void;
  reset(): void;
}

/** Whether a sidecar entry holds anything worth asking about. */
function hasContent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.length > 0;
    return parsed !== null && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Put a destination back to what it held before apply() touched it. */
function restore(key: string, before: string | null): void {
  try {
    if (before === null) localStorage.removeItem(key);
    else localStorage.setItem(key, before);
  } catch {
    /* over quota again, for a value that fit a moment ago; nothing more to do */
  }
}

function removeLegacy(legacyKey: string): void {
  for (const key of SIDECARS) {
    try {
      localStorage.removeItem(key(legacyKey));
    } catch {
      /* storage unavailable; nothing to delete then */
    }
  }
}

export const useLegacySidecarStore = create<LegacySidecarState>((set, get) => ({
  pending: null,

  detect: (fingerprint, legacyKey) => {
    // Same key means the content hash was unavailable and the stores loaded
    // under the engine's fingerprint directly; there is no "old" state apart
    // from what they already loaded.
    if (legacyKey === fingerprint) {
      set({ pending: null });
      return;
    }
    const oldState = SIDECARS.some((key) => hasContent(read(key(legacyKey))));
    const newState = SIDECARS.some((key) => hasContent(read(key(fingerprint))));
    set({ pending: oldState && !newState ? { fingerprint, legacyKey } : null });
  },

  apply: () => {
    const { pending } = get();
    if (!pending) return;
    // Refused, not queued, while a page operation (or an open, or a combine)
    // is renumbering the very stores this rewrites. Its undo snapshot was
    // taken before the copy landed and would discard it, with the old entries
    // already gone by then.
    const release = useDocumentMutationStore
      .getState()
      .acquire({ owner: 'migration', scope: 'pages' });
    if (!release) {
      pushToast(DOCUMENT_MUTATION_BUSY_TITLE, 'info');
      announce(DOCUMENT_MUTATION_BUSY_TITLE, true);
      return;
    }
    try {
      const { fingerprint, legacyKey } = pending;
      // What each destination held before this call, so a failed write can
      // put every earlier one back exactly as it was.
      const written: Array<{ key: string; before: string | null }> = [];
      for (const key of SIDECARS) {
        const raw = read(key(legacyKey));
        if (raw === null) continue;
        // The same test detect() applied, so a destination holding only `[]`
        // or `{}` (a store that wrote its empty collection through) counts
        // as nothing, as it did when the offer was made.
        const target = key(fingerprint);
        const before = read(target);
        if (hasContent(before)) continue;
        try {
          localStorage.setItem(target, raw);
          written.push({ key: target, before });
        } catch {
          for (const entry of written) restore(entry.key, entry.before);
          const message =
            'Could not apply the saved edits: browser storage is full. ' +
            'Nothing was changed; free some space, or discard them.';
          pushToast(message, 'error');
          announce(message, true);
          return;
        }
      }
      removeLegacy(legacyKey);
      set({ pending: null });
      // Reload rather than copy in memory: the stores already parse and
      // sanitize what they read, and this is the one path that does it.
      if (useDocumentStore.getState().info?.fingerprint !== fingerprint) return;
      useAnnotationStore.getState().loadForDocument(fingerprint);
      useSignatureStore.getState().loadForDocument(fingerprint);
      useEditStore.getState().loadForDocument(fingerprint);
      useOcrStore.getState().loadForDocument(fingerprint);
    } finally {
      release();
    }
  },

  discard: () => {
    const { pending } = get();
    if (!pending) return;
    removeLegacy(pending.legacyKey);
    set({ pending: null });
  },

  reset: () => set({ pending: null }),
}));
