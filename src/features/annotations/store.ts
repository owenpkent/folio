import { create } from 'zustand';

import type { Annotation, NormalizedRect } from './types';

/**
 * Annotations are stored per document, keyed by the PDF fingerprint, in a
 * local sidecar (localStorage today), which keeps the open PDF untouched while
 * you review. Saving a copy writes them into that copy as real PDF annotations
 * — see `stampAnnotations` in ./bake.ts.
 */

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `anno-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }
}

const storageKey = (fingerprint: string) => `folio.annotations.${fingerprint}`;

interface AnnotationState {
  fingerprint: string | null;
  annotations: Annotation[];

  loadForDocument(fingerprint: string): void;
  reset(): void;
  addHighlight(
    pageNumber: number,
    rects: NormalizedRect[],
    text: string,
    color: string,
  ): Annotation;
  /**
   * Drop a sticky note at a page-relative anchor. `contextText` is the text the
   * note refers to (the exact selection, or nearby text for a point note), and
   * `rects` optionally marks the referenced text so it can be underlined.
   */
  addNote(
    pageNumber: number,
    anchor: { x: number; y: number },
    contextText: string,
    color: string,
    rects?: NormalizedRect[],
  ): Annotation;
  /** Move a note's anchor (drag). */
  moveNote(id: string, anchor: { x: number; y: number }): void;
  setNote(id: string, note: string): void;
  remove(id: string): void;
}

export const useAnnotationStore = create<AnnotationState>((set, get) => {
  const persist = () => {
    const { fingerprint, annotations } = get();
    if (!fingerprint) return;
    try {
      localStorage.setItem(storageKey(fingerprint), JSON.stringify(annotations));
    } catch {
      /* storage unavailable; annotations remain in memory */
    }
  };

  return {
    fingerprint: null,
    annotations: [],

    loadForDocument: (fingerprint) => {
      let annotations: Annotation[] = [];
      try {
        const raw = localStorage.getItem(storageKey(fingerprint));
        if (raw) annotations = JSON.parse(raw) as Annotation[];
      } catch {
        annotations = [];
      }
      set({ fingerprint, annotations });
    },

    reset: () => set({ fingerprint: null, annotations: [] }),

    addHighlight: (pageNumber, rects, text, color) => {
      const annotation: Annotation = {
        id: uid(),
        type: 'highlight',
        pageNumber,
        rects,
        text,
        color,
        createdAt: Date.now(),
      };
      set((s) => ({ annotations: [...s.annotations, annotation] }));
      persist();
      return annotation;
    },

    addNote: (pageNumber, anchor, contextText, color, rects = []) => {
      const annotation: Annotation = {
        id: uid(),
        type: 'note',
        pageNumber,
        rects,
        anchor,
        text: contextText,
        note: '',
        color,
        createdAt: Date.now(),
      };
      set((s) => ({ annotations: [...s.annotations, annotation] }));
      persist();
      return annotation;
    },

    moveNote: (id, anchor) => {
      set((s) => ({
        annotations: s.annotations.map((a) => (a.id === id ? { ...a, anchor } : a)),
      }));
      persist();
    },

    setNote: (id, note) => {
      set((s) => ({
        annotations: s.annotations.map((a) => (a.id === id ? { ...a, note } : a)),
      }));
      persist();
    },

    remove: (id) => {
      set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) }));
      persist();
    },
  };
});
