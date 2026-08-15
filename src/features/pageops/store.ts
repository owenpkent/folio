import { create } from 'zustand';

import type { PageOpsSnapshot } from './pageState';

/**
 * Oldest snapshots drop first past this many entries. Each one holds a whole
 * copy of the document, so this is the same trade textedit's undo stack makes:
 * deep enough to cover a run of edits, shallow enough not to pin ten copies of
 * a large PDF in memory forever.
 */
const UNDO_LIMIT = 10;

interface PageOpsState {
  /** Selected pages, as 1-based page numbers. */
  selection: Set<number>;
  /** The page a shift-click extends its range from. */
  anchor: number | null;
  /** True while a plan is being written; keeps a second commit from racing it. */
  busy: boolean;
  /** Whether the full-window page organizer is open. */
  organizing: boolean;
  /** Whether this document's "changing pages breaks the signature" warning has been shown. */
  warnedAboutSignatures: boolean;
  /** Pre-op snapshots, oldest first, capped at {@link UNDO_LIMIT}. */
  undoStack: PageOpsSnapshot[];

  /** Make `pageNumber` the whole selection, and the anchor for a later range. */
  select(pageNumber: number): void;
  /** Add or remove one page, leaving the rest of the selection alone. */
  toggle(pageNumber: number): void;
  /** Replace the selection with the range from the anchor to `pageNumber`. */
  extendTo(pageNumber: number): void;
  selectAll(numPages: number): void;
  clearSelection(): void;
  /** Carry the selection across a plan, dropping pages the plan deleted. */
  remapSelection(pageMap: Map<number, number>): void;
  setBusy(busy: boolean): void;
  setOrganizing(organizing: boolean): void;
  markSignaturesWarned(): void;
  pushUndo(snapshot: PageOpsSnapshot): void;
  popUndo(): PageOpsSnapshot | null;
  /**
   * Drop the whole undo stack without restoring anything. Text editing keeps
   * its own separate undo stack bound to the same Mod+z chord (see
   * commands.ts); once either one commits or undoes, the other's snapshots
   * are byte-states from before that change, so they get invalidated here
   * rather than left around to silently discard it later.
   */
  clearUndo(): void;
  reset(): void;
}

/**
 * Selection and undo state for page operations. Not persisted: which pages are
 * selected is a property of the current sitting, not of the document, and the
 * undo snapshots are whole-document byte copies that have no business in
 * localStorage.
 */
export const usePageOpsStore = create<PageOpsState>((set, get) => ({
  selection: new Set(),
  anchor: null,
  busy: false,
  organizing: false,
  warnedAboutSignatures: false,
  undoStack: [],

  select: (pageNumber) => set({ selection: new Set([pageNumber]), anchor: pageNumber }),

  toggle: (pageNumber) =>
    set((s) => {
      const selection = new Set(s.selection);
      if (!selection.delete(pageNumber)) selection.add(pageNumber);
      return { selection, anchor: pageNumber };
    }),

  extendTo: (pageNumber) =>
    set((s) => {
      if (s.anchor === null) return { selection: new Set([pageNumber]), anchor: pageNumber };
      const from = Math.min(s.anchor, pageNumber);
      const to = Math.max(s.anchor, pageNumber);
      const selection = new Set<number>();
      for (let page = from; page <= to; page += 1) selection.add(page);
      // The anchor stays put, so dragging the shift-click back and forth grows
      // and shrinks one range instead of leaving a trail.
      return { selection };
    }),

  selectAll: (numPages) =>
    set({
      selection: new Set(Array.from({ length: numPages }, (_, i) => i + 1)),
      anchor: numPages > 0 ? 1 : null,
    }),

  clearSelection: () => set({ selection: new Set(), anchor: null }),

  remapSelection: (pageMap) =>
    set((s) => {
      const selection = new Set<number>();
      for (const page of s.selection) {
        const moved = pageMap.get(page);
        if (moved !== undefined) selection.add(moved);
      }
      const anchor = s.anchor === null ? null : (pageMap.get(s.anchor) ?? null);
      return { selection, anchor };
    }),

  setBusy: (busy) => set({ busy }),
  setOrganizing: (organizing) => set({ organizing }),
  markSignaturesWarned: () => set({ warnedAboutSignatures: true }),

  pushUndo: (snapshot) =>
    set((s) => {
      const next = [...s.undoStack, snapshot];
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

  clearUndo: () => set({ undoStack: [] }),

  reset: () =>
    set({
      selection: new Set(),
      anchor: null,
      busy: false,
      organizing: false,
      warnedAboutSignatures: false,
      undoStack: [],
    }),
}));
