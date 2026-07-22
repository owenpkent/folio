import { create } from 'zustand';

import { isTauri } from '@/core/document/openDocument';
import type { OutlineNode, PdfDocumentInfo, PdfMetadata } from '@/core/pdf';

export type DocumentStatus = 'empty' | 'loading' | 'ready' | 'error';

interface DocumentState {
  status: DocumentStatus;
  info: PdfDocumentInfo | null;
  metadata: PdfMetadata | null;
  outline: OutlineNode[];
  error: string | null;
  /**
   * Absolute on-disk path of the open document (desktop only). Null for
   * browser files, fetched URLs, and anything else Save-in-place can't
   * write back to.
   */
  sourcePath: string | null;
  /**
   * True from first paint until startup file handling has settled (desktop:
   * whether the OS handed Folio a PDF to open). While booting, the empty
   * state shows only the splash branding, so launching Folio by
   * double-clicking a PDF never flashes the open-a-document UI.
   */
  booting: boolean;
  /**
   * Bumped whenever the engine's document bytes are swapped in place (e.g. an
   * in-place text edit) without changing fingerprint or resetting per-feature
   * state. Pages key off this to remount and re-render from the new bytes.
   */
  docVersion: number;

  setStatus(status: DocumentStatus): void;
  setLoaded(info: PdfDocumentInfo, metadata: PdfMetadata, outline: OutlineNode[]): void;
  setError(message: string): void;
  setSourcePath(path: string | null): void;
  setBooted(): void;
  bumpDocVersion(): void;
  reset(): void;
}

export const useDocumentStore = create<DocumentState>((set) => ({
  status: 'empty',
  info: null,
  metadata: null,
  outline: [],
  error: null,
  sourcePath: null,
  // Only the desktop app can be handed a launch file, so only it boots gated.
  booting: isTauri(),
  docVersion: 0,

  setStatus: (status) => set({ status }),
  setLoaded: (info, metadata, outline) =>
    set({ status: 'ready', info, metadata, outline, error: null, docVersion: 0 }),
  setError: (error) => set({ status: 'error', error }),
  setSourcePath: (sourcePath) => set({ sourcePath }),
  setBooted: () => set({ booting: false }),
  bumpDocVersion: () => set((s) => ({ docVersion: s.docVersion + 1 })),
  reset: () =>
    set({
      status: 'empty',
      info: null,
      metadata: null,
      outline: [],
      error: null,
      sourcePath: null,
      docVersion: 0,
    }),
}));
