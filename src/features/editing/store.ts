import { create } from 'zustand';

import { uid } from '@/core/id';

import {
  DEFAULT_FONT_SIZE_PT,
  DEFAULT_MARK_COLOR,
  DEFAULT_TEXT_COLOR,
  MARK_GLYPH_PATHS,
  type EditItem,
  type ImageEdit,
  type MarkEdit,
  type MarkGlyph,
  type MarkStylePatch,
  type NormalizedRect,
  type TextEdit,
  type TextStylePatch,
} from './types';

/**
 * Placed edits (text boxes, images, check marks) for the current document,
 * persisted per PDF fingerprint in a local sidecar. Mirrors
 * features/signatures/store. The `selectedId` / `focusId` fields are
 * transient UI state and are never persisted.
 */

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
  addMark(pageNumber: number, rect: NormalizedRect, glyph: MarkGlyph): MarkEdit;
  move(id: string, rect: NormalizedRect): void;
  updateText(id: string, patch: TextStylePatch): void;
  updateMark(id: string, patch: MarkStylePatch): void;
  remove(id: string): void;
  /** Replace the whole collection: page ops rewriting page numbers in bulk, or restoring an undo snapshot. */
  replaceAll(edits: EditItem[]): void;

  select(id: string | null): void;
  /** Select a text box and put the caret in it (used after a click that was not a drag). */
  focus(id: string): void;
  clearFocus(): void;
}

/**
 * Keep only well-formed items from the sidecar. localStorage is user-writable,
 * so its contents are untrusted input: a `mark` whose `glyph` is not one this
 * build knows would index MARK_GLYPH_PATHS to undefined, which renders as an
 * empty `<path d>` on screen but throws inside pdf-lib's drawSvgPath when the
 * document is exported -- a failure a long way from its cause. Unknown `kind`s
 * are dropped for the same reason: EditLayer's dispatch treats anything that is
 * neither text nor mark as an image and would read a dataUrl that isn't there.
 */
function sanitizeEdits(raw: unknown): EditItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is EditItem => {
    if (!item || typeof item !== 'object') return false;
    const { kind, id, rect } = item as Partial<EditItem>;
    if (typeof id !== 'string' || !rect || typeof rect !== 'object') return false;
    if (kind === 'text') return true;
    if (kind === 'image') return typeof (item as Partial<ImageEdit>).dataUrl === 'string';
    if (kind === 'mark') return (item as Partial<MarkEdit>).glyph! in MARK_GLYPH_PATHS;
    return false;
  });
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
        if (raw) edits = sanitizeEdits(JSON.parse(raw));
      } catch {
        edits = [];
      }
      set({ fingerprint, edits, selectedId: null, focusId: null });
    },

    reset: () => set({ fingerprint: null, edits: [], selectedId: null, focusId: null }),

    addText: (pageNumber, rect) => {
      const item: TextEdit = {
        id: uid('edit'),
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
        id: uid('edit'),
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

    addMark: (pageNumber, rect, glyph) => {
      const item: MarkEdit = {
        id: uid('edit'),
        kind: 'mark',
        pageNumber,
        rect,
        glyph,
        colorHex: DEFAULT_MARK_COLOR,
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

    updateMark: (id, patch) => {
      set((s) => ({
        edits: s.edits.map((e) => (e.id === id && e.kind === 'mark' ? { ...e, ...patch } : e)),
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

    replaceAll: (edits) => {
      set({ edits });
      persist();
    },

    select: (id) => set({ selectedId: id }),
    focus: (id) => set({ selectedId: id, focusId: id }),
    clearFocus: () => set({ focusId: null }),
  };
});
