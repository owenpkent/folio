import { create } from 'zustand';

import type { NormalizedRect, Signature } from './types';

/**
 * Placed signatures, stored per document (keyed by PDF fingerprint) in a local
 * sidecar, exactly like annotations. They are baked into the PDF only when the
 * user saves a copy (see features/export).
 */

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `sig-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

const storageKey = (fingerprint: string) => `folio.signatures.${fingerprint}`;

interface SignatureState {
  fingerprint: string | null;
  signatures: Signature[];

  loadForDocument(fingerprint: string): void;
  reset(): void;
  add(pageNumber: number, dataUrl: string, rect: NormalizedRect): Signature;
  move(id: string, rect: NormalizedRect): void;
  remove(id: string): void;
}

export const useSignatureStore = create<SignatureState>((set, get) => {
  const persist = () => {
    const { fingerprint, signatures } = get();
    if (!fingerprint) return;
    try {
      localStorage.setItem(storageKey(fingerprint), JSON.stringify(signatures));
    } catch {
      /* storage unavailable; signatures remain in memory */
    }
  };

  return {
    fingerprint: null,
    signatures: [],

    loadForDocument: (fingerprint) => {
      let signatures: Signature[] = [];
      try {
        const raw = localStorage.getItem(storageKey(fingerprint));
        if (raw) signatures = JSON.parse(raw) as Signature[];
      } catch {
        signatures = [];
      }
      set({ fingerprint, signatures });
    },

    reset: () => set({ fingerprint: null, signatures: [] }),

    add: (pageNumber, dataUrl, rect) => {
      const signature: Signature = { id: uid(), pageNumber, dataUrl, rect, createdAt: Date.now() };
      set((s) => ({ signatures: [...s.signatures, signature] }));
      persist();
      return signature;
    },

    move: (id, rect) => {
      set((s) => ({ signatures: s.signatures.map((sig) => (sig.id === id ? { ...sig, rect } : sig)) }));
      persist();
    },

    remove: (id) => {
      set((s) => ({ signatures: s.signatures.filter((sig) => sig.id !== id) }));
      persist();
    },
  };
});
