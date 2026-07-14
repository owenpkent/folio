import { create } from 'zustand';

import {
  DEFAULT_FONT_SIZE_PT,
  DEFAULT_TEXT_COLOR,
  type EditItem,
  type ImageEdit,
  type NormalizedRect,
  type TextEdit,
  type TextStylePatch,
} from './types';

/**
 * Placed edits (text boxes + images) for the current document, persisted per
 * PDF fingerprint in a local sidecar. Mirrors features/signatures/store. The
 * `selectedId` / `focusId` fields are transient UI state and are never
 * persisted.
 */

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `edit-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

const storageKey = (fingerprint: string) => `folio.edits.${fingerprint}`;

interface EditState {
  fingerprint: string | null;
  edits: EditItem[];
  /** The item showing selection chrome (inspector, handles), if any. */
  selectedId: string | null;
  /** A text box that should grab keyboard focus once mounted (just created). */
  focusId: string | null;

  loadForDocument(fingerprint: string): void;
  reset(): void;

  addText(pageNumber: number, rect: NormalizedRect): TextEdit;
  addImage(
    pageNumber: number,
    dataUrl: string,
    mime: ImageEdit['mime'],
    rect: NormalizedRect,
  ): ImageEdit;
  move(id: string, rect: NormalizedRect): void;
  updateText(id: string, patch: TextStylePatch): void;
  remove(id: string): void;

  select(id: string | null): void;
  clearFocus(): void;
}

export const useEditStore = create<EditState>((set, get) => {
  const persist = () => {
    const { fingerprint, edits } = get();
    if (!fingerprint) return;
    try {
      localStorage.setItem(storageKey(fingerprint), JSON.stringify(edits));
    } catch {
      /* storage unavailable; edits remain in memory */
    }
  };

  return {
    fingerprint: null,
    edits: [],
    selectedId: null,
    focusId: null,

    loadForDocument: (fingerprint) => {
      let edits: EditItem[] = [];
      try {
        const raw = localStorage.getItem(storageKey(fingerprint));
        if (raw) edits = JSON.parse(raw) as EditItem[];
      } catch {
        edits = [];
      }
      set({ fingerprint, edits, selectedId: null, focusId: null });
    },

    reset: () => set({ fingerprint: null, edits: [], selectedId: null, focusId: null }),

    addText: (pageNumber, rect) => {
      const item: TextEdit = {
        id: uid(),
        kind: 'text',
        pageNumber,
        rect,
        text: '',
        fontFamily: 'Helvetica',
        bold: false,
        fontSizePt: DEFAULT_FONT_SIZE_PT,
        colorHex: DEFAULT_TEXT_COLOR,
        createdAt: Date.now(),
      };
      set((s) => ({ edits: [...s.edits, item], selectedId: item.id, focusId: item.id }));
      persist();
      return item;
    },

    addImage: (pageNumber, dataUrl, mime, rect) => {
      const item: ImageEdit = {
        id: uid(),
        kind: 'image',
        pageNumber,
        rect,
        dataUrl,
        mime,
        createdAt: Date.now(),
      };
      set((s) => ({ edits: [...s.edits, item], selectedId: item.id }));
      persist();
      return item;
    },

    move: (id, rect) => {
      set((s) => ({ edits: s.edits.map((e) => (e.id === id ? { ...e, rect } : e)) }));
      persist();
    },

    updateText: (id, patch) => {
      set((s) => ({
        edits: s.edits.map((e) => (e.id === id && e.kind === 'text' ? { ...e, ...patch } : e)),
      }));
      persist();
    },

    remove: (id) => {
      set((s) => ({
        edits: s.edits.filter((e) => e.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        focusId: s.focusId === id ? null : s.focusId,
      }));
      persist();
    },

    select: (id) => set({ selectedId: id }),
    clearFocus: () => set({ focusId: null }),
  };
});
