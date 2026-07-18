import { create } from 'zustand';

import type { OutlineNode, PdfDocumentInfo, PdfMetadata } from '@/core/pdf';

export type DocumentStatus = 'empty' | 'loading' | 'ready' | 'error';

interface DocumentState {
  status: DocumentStatus;
  info: PdfDocumentInfo | null;
  metadata: PdfMetadata | null;
  outline: OutlineNode[];
  error: string | null;
  /**
   * Bumped whenever the engine's document bytes are swapped in place (e.g. an
   * in-place text edit) without changing fingerprint or resetting per-feature
   * state. Pages key off this to remount and re-render from the new bytes.
   */
  docVersion: number;

  setStatus(status: DocumentStatus): void;
  setLoaded(info: PdfDocumentInfo, metadata: PdfMetadata, outline: OutlineNode[]): void;
  setError(message: string): void;
  bumpDocVersion(): void;
  reset(): void;
}

export const useDocumentStore = create<DocumentState>((set) => ({
  status: 'empty',
  info: null,
  metadata: null,
  outline: [],
  error: null,
  docVersion: 0,

  setStatus: (status) => set({ status }),
  setLoaded: (info, metadata, outline) =>
    set({ status: 'ready', info, metadata, outline, error: null, docVersion: 0 }),
  setError: (error) => set({ status: 'error', error }),
  bumpDocVersion: () => set((s) => ({ docVersion: s.docVersion + 1 })),
  reset: () =>
    set({ status: 'empty', info: null, metadata: null, outline: [], error: null, docVersion: 0 }),
}));
