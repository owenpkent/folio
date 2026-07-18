import { create } from 'zustand';

import type { RunColor, ShowOp } from './types';

/** Baseline origin + operator kind used to re-locate the edited run on commit. */
export interface EditingSessionTarget {
  x: number;
  y: number;
  op: ShowOp;
}

/** The editor overlay's position and size within its page element, in CSS pixels. */
export interface EditingSessionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The text run currently open for in-place editing. Only one is open at a time. */
export interface EditingSession {
  /** 0-based page index. */
  pageIndex: number;
  target: EditingSessionTarget;
  /** The run's current text: prefills the editor and detects no-op edits. */
  prefillText: string;
  cssRect: EditingSessionRect;
  fontFamily: string;
  fontSizePx: number;
  color: RunColor;
  /** The run's font size in PDF user units (as opposed to fontSizePx, in CSS px). */
  fontSize: number;
}

/** Oldest snapshots drop first once the undo stack passes this many entries. */
const UNDO_LIMIT = 10;

interface TextEditState {
  /** Whether the "Edit text" tool is on; gates the overlay's hit-testing. */
  active: boolean;
  /** The in-progress edit, if any. */
  session: EditingSession | null;
  /** Pre-edit document snapshots, oldest first, capped at {@link UNDO_LIMIT}. */
  undoStack: Uint8Array[];

  toggleActive(): void;
  beginSession(session: EditingSession): void;
  endSession(): void;
  pushUndo(bytes: Uint8Array): void;
  popUndo(): Uint8Array | null;
  reset(): void;
}

/**
 * Transient UI + undo state for in-place text editing (not persisted: edits
 * apply immediately to the engine's document, so there is nothing per-document
 * to reload). Mirrors the shape of other feature stores (see features/editing)
 * without the localStorage sidecar.
 */
export const useTextEditStore = create<TextEditState>((set, get) => ({
  active: false,
  session: null,
  undoStack: [],

  toggleActive: () => set((s) => ({ active: !s.active })),
  beginSession: (session) => set({ session }),
  endSession: () => set({ session: null }),

  pushUndo: (bytes) =>
    set((s) => {
      const next = [...s.undoStack, bytes];
      if (next.length > UNDO_LIMIT) next.shift();
      return { undoStack: next };
    }),

  popUndo: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return null;
    const popped = undoStack[undoStack.length - 1];
    set({ undoStack: undoStack.slice(0, -1) });
    return popped;
  },

  reset: () => set({ active: false, session: null, undoStack: [] }),
}));
