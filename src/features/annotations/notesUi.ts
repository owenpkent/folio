import { create } from 'zustand';

/** Transient UI state for note placement/editing (not persisted). */
interface NotesUiState {
  /** When true, the next click on a page drops a note. */
  adding: boolean;
  /** The note whose editor is open, if any. */
  activeId: string | null;
  setAdding(v: boolean): void;
  toggleAdding(): void;
  setActive(id: string | null): void;
}

export const useNotesUi = create<NotesUiState>((set) => ({
  adding: false,
  activeId: null,
  setAdding: (adding) => set({ adding }),
  toggleAdding: () => set((s) => ({ adding: !s.adding })),
  setActive: (activeId) => set({ activeId }),
}));

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Concatenate the page's text within a vertical band around the anchor. Captured
 * when a note is placed so the note carries the content it refers to; the AI
 * export reports this so an assistant can locate the note in the document.
 */
export function textNearAnchor(
  pageEl: HTMLElement,
  anchor: { x: number; y: number },
  band = 0.05,
): string {
  const spans = pageEl.querySelectorAll<HTMLElement>('.folio-text-layer span');
  const pr = pageEl.getBoundingClientRect();
  const near: { y: number; x: number; t: string }[] = [];
  spans.forEach((s) => {
    const r = s.getBoundingClientRect();
    const cy = (r.top + r.height / 2 - pr.top) / pr.height;
    if (Math.abs(cy - anchor.y) <= band) {
      near.push({ y: cy, x: (r.left - pr.left) / pr.width, t: s.textContent ?? '' });
    }
  });
  near.sort((a, b) => a.y - b.y || a.x - b.x);
  return near
    .map((n) => n.t)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
