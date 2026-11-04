import { create } from 'zustand';

import { storageKey as annotationKey, useAnnotationStore } from '@/features/annotations/store';
import { storageKey as editKey, useEditStore } from '@/features/editing/store';
import { storageKey as ocrKey, useOcrStore } from '@/features/ocr/store';
import { storageKey as signatureKey, useSignatureStore } from '@/features/signatures/store';
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
  /** Move the old entries under this document's key and reload the stores. */
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
    const { fingerprint, legacyKey } = pending;
    for (const key of SIDECARS) {
      const raw = read(key(legacyKey));
      if (raw === null) continue;
      try {
        if (read(key(fingerprint)) === null) localStorage.setItem(key(fingerprint), raw);
      } catch {
        /* over quota: the old entry stays put below, so nothing is lost */
        continue;
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
  },

  discard: () => {
    const { pending } = get();
    if (!pending) return;
    removeLegacy(pending.legacyKey);
    set({ pending: null });
  },

  reset: () => set({ pending: null }),
}));
