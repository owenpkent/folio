import { create } from 'zustand';

export type PrintStatus = 'idle' | 'preparing' | 'error';

interface PrintProgress {
  /** 1-based page currently being rasterized (0 = not started). */
  current: number;
  total: number;
}

interface PrintState {
  status: PrintStatus;
  progress: PrintProgress;
  error: string | null;
  cancelRequested: boolean;

  start(total: number): void;
  setTotal(total: number): void;
  setProgress(current: number): void;
  finish(): void;
  fail(message: string): void;
  requestCancel(): void;
}

const IDLE: PrintProgress = { current: 0, total: 0 };

/**
 * Transient state for the print rasterization pass. Nothing here is persisted:
 * a print run is over the moment the system dialog closes.
 */
export const usePrintStore = create<PrintState>((set) => ({
  status: 'idle',
  progress: IDLE,
  error: null,
  cancelRequested: false,

  start: (total) =>
    set({
      status: 'preparing',
      progress: { current: 0, total },
      error: null,
      cancelRequested: false,
    }),
  setTotal: (total) => set((s) => ({ progress: { ...s.progress, total } })),
  setProgress: (current) => set((s) => ({ progress: { ...s.progress, current } })),
  finish: () => set({ status: 'idle', progress: IDLE, cancelRequested: false }),
  fail: (message) =>
    set({ status: 'error', error: message, progress: IDLE, cancelRequested: false }),
  requestCancel: () => set({ cancelRequested: true }),
}));
