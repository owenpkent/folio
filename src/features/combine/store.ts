import type { PDFDocument } from 'pdf-lib';
import { create } from 'zustand';

import { uid } from '@/core/id';

import { MAX_COMBINE_INPUT_BYTES, MAX_COMBINE_INPUTS, stagePdf } from './combineDocuments';

/** A file staged for the next combine run, in the order it will be merged. */
export interface PendingFile {
  id: string;
  name: string;
  /**
   * The raw file, dropped once {@link stagePdf} has parsed it into `doc`.
   * Nothing reads it after that -- the merge takes `doc` -- and holding both
   * kept a second full copy of every staged file resident for as long as the
   * modal stayed open, on top of the parsed graph and the merged document
   * being built from it.
   */
  bytes?: Uint8Array;
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
  /**
   * Polled by the in-flight merge; see commands.ts's runCombine. Cleared by
   * startRun, not by the run itself finishing: a cancelled run leaves the
   * modal open (nothing calls close(), which is the other place this
   * resets) so the user can pick up where they left off, and this must not
   * still read true the next time they click Combine.
   */
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
  /** Enter the busy state for a fresh run: clears any error and, critically,
   * any cancelRequested left over from a previous run that was cancelled
   * (see the note on that field above -- cancelling never calls close(), so
   * nothing else clears it before the next run starts). */
  startRun(total: number): void;
  /** Leave the busy state once a run (successful, failed, or cancelled) is done. */
  endRun(): void;
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
    if (newFiles.length === 0) return;
    const current = get();

    // Refused outright while a merge is in flight. runCombine snapshotted its
    // inputs before these arrived, so they would sit in the list looking
    // included while being no part of the merge -- and its success path calls
    // close(), which wipes the whole list without warning. Losing the user's
    // files silently is worse than saying no.
    if (current.busy) {
      set({ error: 'Finish or cancel the combine in progress before adding more files.' });
      return;
    }

    // Ceilings, because nothing else bounds this: the list holds every file's
    // parsed object graph at once and the merge then builds a copy of all of
    // them, so an unbounded staging list is a memory-exhaustion hang reachable
    // by dropping a folder onto the window.
    if (current.files.length + newFiles.length > MAX_COMBINE_INPUTS) {
      set({
        error: `Combine takes up to ${MAX_COMBINE_INPUTS} files at once. Combine them in batches, then combine the results.`,
      });
      return;
    }
    const oversized = newFiles.filter((f) => f.bytes.byteLength > MAX_COMBINE_INPUT_BYTES);
    if (oversized.length > 0) {
      const limitMb = Math.round(MAX_COMBINE_INPUT_BYTES / (1024 * 1024));
      set({
        error: `"${oversized[0].name}" is too large to combine (over ${limitMb}MB).`,
      });
      return;
    }

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
    entries.forEach((entry, i) => {
      const id = entry.id;
      // Read from the seed, not from `entry`: `PendingFile.bytes` is optional
      // (it is dropped on success below) while a seed always has them.
      void stagePdf(newFiles[i].bytes, newFiles[i].name)
        .then(({ pageCount, doc }) => {
          set((s) => ({
            // `bytes: undefined` releases the raw file now that `doc` holds
            // everything the merge needs from it (see PendingFile.bytes).
            files: s.files.map((f) =>
              f.id === id ? { ...f, pageCount, doc, bytes: undefined } : f,
            ),
          }));
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Could not read this file';
          set((s) => ({
            files: s.files.map((f) => (f.id === id ? { ...f, error: message } : f)),
          }));
        });
    });
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

  startRun: (total) =>
    set({ busy: true, error: null, cancelRequested: false, progress: { current: 0, total } }),
  endRun: () => set({ busy: false, progress: IDLE_PROGRESS }),
}));
