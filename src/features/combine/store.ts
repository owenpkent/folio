import type { PDFDocument } from 'pdf-lib';
import { create } from 'zustand';

import { uid } from '@/core/id';

import { stagePdf } from './combineDocuments';

/** A file staged for the next combine run, in the order it will be merged. */
export interface PendingFile {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** Undefined while the page count is still being read. */
  pageCount?: number;
  /** Set when the file could not be read (corrupt, encrypted, not a PDF). */
  error?: string;
  /**
   * Parsed once here (by {@link stagePdf}, to read `pageCount`) and reused by
   * the merge instead of parsing the same bytes a second time when it runs.
   */
  doc?: PDFDocument;
}

interface CombineProgress {
  /** Inputs folded in so far (0 = not started). */
  current: number;
  total: number;
}

const IDLE_PROGRESS: CombineProgress = { current: 0, total: 0 };

/** A file handed to {@link CombineState.open} or {@link CombineState.addFiles}. */
export interface CombineFileSeed {
  name: string;
  bytes: Uint8Array;
}

interface CombineState {
  modalOpen: boolean;
  files: PendingFile[];
  busy: boolean;
  error: string | null;
  progress: CombineProgress;
  /** Polled by the in-flight merge; see commands.ts's runCombine. */
  cancelRequested: boolean;

  /** Open the modal, optionally pre-loaded with files (e.g. from a drop). */
  open(seed?: CombineFileSeed[]): void;
  close(): void;
  addFiles(files: CombineFileSeed[]): void;
  removeFile(id: string): void;
  moveUp(id: string): void;
  moveDown(id: string): void;
  clear(): void;
  setBusy(busy: boolean): void;
  setError(message: string | null): void;
  setProgress(current: number, total: number): void;
  requestCancel(): void;
}

/**
 * Transient state for the "Combine PDFs" modal. Nothing here is persisted:
 * the pending file list only exists for the length of one combine run, like
 * the print and OCR progress stores.
 */
export const useCombineStore = create<CombineState>((set, get) => ({
  modalOpen: false,
  files: [],
  busy: false,
  error: null,
  progress: IDLE_PROGRESS,
  cancelRequested: false,

  open: (seed) => {
    set({
      modalOpen: true,
      files: [],
      busy: false,
      error: null,
      progress: IDLE_PROGRESS,
      cancelRequested: false,
    });
    if (seed && seed.length > 0) get().addFiles(seed);
  },

  close: () =>
    set({
      modalOpen: false,
      files: [],
      busy: false,
      error: null,
      progress: IDLE_PROGRESS,
      cancelRequested: false,
    }),

  addFiles: (newFiles) => {
    const entries: PendingFile[] = newFiles.map((f) => ({
      id: uid('combine'),
      name: f.name,
      bytes: f.bytes,
    }));
    set((s) => ({ files: [...s.files, ...entries], error: null }));

    // Page counts (and the parsed document, cached for the merge -- see
    // PendingFile.doc) are read asynchronously and patched onto each entry as
    // they resolve, so a slow or huge file does not hold up the others -- or
    // the dialog's own file-picked resolution -- from showing up in the list.
    //
    // Only `id` is captured per entry, not `entry` itself: closing over the
    // whole object would keep its `.bytes` (and, once parsed, `.doc`) alive
    // for as long as this promise is pending, even if the user removes the
    // file from the list before it settles.
    for (const entry of entries) {
      const id = entry.id;
      void stagePdf(entry.bytes, entry.name)
        .then(({ pageCount, doc }) => {
          set((s) => ({
            files: s.files.map((f) => (f.id === id ? { ...f, pageCount, doc } : f)),
          }));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Could not read this file';
          set((s) => ({
            files: s.files.map((f) => (f.id === id ? { ...f, error: message } : f)),
          }));
        });
    }
  },

  // Each of these clears `error` on an actual change, same as addFiles: an
  // alert left over from a file the user already removed (or reordered away
  // from) just names something no longer in the visible list.
  removeFile: (id) => set((s) => ({ files: s.files.filter((f) => f.id !== id), error: null })),

  moveUp: (id) =>
    set((s) => {
      const idx = s.files.findIndex((f) => f.id === id);
      if (idx <= 0) return s;
      const files = [...s.files];
      [files[idx - 1], files[idx]] = [files[idx], files[idx - 1]];
      return { files, error: null };
    }),

  moveDown: (id) =>
    set((s) => {
      const idx = s.files.findIndex((f) => f.id === id);
      if (idx === -1 || idx >= s.files.length - 1) return s;
      const files = [...s.files];
      [files[idx + 1], files[idx]] = [files[idx], files[idx + 1]];
      return { files, error: null };
    }),

  clear: () => set({ files: [], error: null }),

  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setProgress: (current, total) => set({ progress: { current, total } }),
  requestCancel: () => set({ cancelRequested: true }),
}));
