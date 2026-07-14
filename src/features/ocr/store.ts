import { create } from 'zustand';

import type { OcrPage, OcrStatus } from './types';

/**
 * OCR results for the current document, persisted per PDF fingerprint so a
 * re-open does not re-recognize. Progress/status/cancel are transient UI state
 * and are not persisted.
 */

const storageKey = (fingerprint: string) => `folio.ocr.${fingerprint}`;

interface OcrProgress {
  /** 1-based page currently being recognized (0 = not started). */
  current: number;
  total: number;
  /** 0..1 progress within the current page. */
  page: number;
}

interface OcrState {
  fingerprint: string | null;
  pages: Record<number, OcrPage>;
  status: OcrStatus;
  progress: OcrProgress;
  error: string | null;
  cancelRequested: boolean;

  loadForDocument(fingerprint: string): void;
  reset(): void;

  start(total: number): void;
  setProgress(current: number, page?: number): void;
  setPage(page: OcrPage): void;
  finish(): void;
  fail(message: string): void;
  requestCancel(): void;
}

export const useOcrStore = create<OcrState>((set, get) => {
  const persist = () => {
    const { fingerprint, pages } = get();
    if (!fingerprint) return;
    try {
      localStorage.setItem(storageKey(fingerprint), JSON.stringify(pages));
    } catch {
      /* storage unavailable or over quota; results stay in memory */
    }
  };

  const idleProgress: OcrProgress = { current: 0, total: 0, page: 0 };

  return {
    fingerprint: null,
    pages: {},
    status: 'idle',
    progress: idleProgress,
    error: null,
    cancelRequested: false,

    loadForDocument: (fingerprint) => {
      let pages: Record<number, OcrPage> = {};
      try {
        const raw = localStorage.getItem(storageKey(fingerprint));
        if (raw) pages = JSON.parse(raw) as Record<number, OcrPage>;
      } catch {
        pages = {};
      }
      set({
        fingerprint,
        pages,
        status: Object.keys(pages).length > 0 ? 'done' : 'idle',
        progress: idleProgress,
        error: null,
        cancelRequested: false,
      });
    },

    reset: () =>
      set({
        fingerprint: null,
        pages: {},
        status: 'idle',
        progress: idleProgress,
        error: null,
        cancelRequested: false,
      }),

    start: (total) =>
      set({ status: 'running', progress: { current: 0, total, page: 0 }, error: null, cancelRequested: false }),

    setProgress: (current, page = 0) =>
      set((s) => ({ progress: { ...s.progress, current, page } })),

    setPage: (page) => {
      set((s) => ({ pages: { ...s.pages, [page.pageNumber]: page } }));
      persist();
    },

    finish: () => set((s) => ({ status: 'done', progress: { ...s.progress, page: 1 } })),

    fail: (message) => set({ status: 'error', error: message }),

    requestCancel: () => set({ cancelRequested: true }),
  };
});
