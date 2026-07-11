import { create } from 'zustand';

import type { OutlineNode, PdfDocumentInfo, PdfMetadata } from '@/core/pdf';

export type DocumentStatus = 'empty' | 'loading' | 'ready' | 'error';

interface DocumentState {
  status: DocumentStatus;
  info: PdfDocumentInfo | null;
  metadata: PdfMetadata | null;
  outline: OutlineNode[];
  error: string | null;

  setStatus(status: DocumentStatus): void;
  setLoaded(info: PdfDocumentInfo, metadata: PdfMetadata, outline: OutlineNode[]): void;
  setError(message: string): void;
  reset(): void;
}

export const useDocumentStore = create<DocumentState>((set) => ({
  status: 'empty',
  info: null,
  metadata: null,
  outline: [],
  error: null,

  setStatus: (status) => set({ status }),
  setLoaded: (info, metadata, outline) =>
    set({ status: 'ready', info, metadata, outline, error: null }),
  setError: (error) => set({ status: 'error', error }),
  reset: () => set({ status: 'empty', info: null, metadata: null, outline: [], error: null }),
}));
