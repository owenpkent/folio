import { create } from 'zustand';

import { clearLocatedImagesCache } from './locateCache';
import type { SelectedImage } from './types';

interface ImageEditState {
  /** Whether the "Edit images" tool is on; gates the overlay's hit-testing. */
  active: boolean;
  /**
   * The image currently showing selection chrome, if any. Not an id: images
   * are derived fresh from the document rather than stored, so this instead
   * carries enough to re-locate the same one afterward (see
   * imageedit/mutate.ts's matchImageToTarget), including through a commit
   * that changes its rect (move) or leaves it alone (replace).
   */
  selected: SelectedImage | null;

  toggleActive(): void;
  select(target: SelectedImage | null): void;
  reset(): void;
}

/**
 * Transient UI state for embedded-image editing (not persisted: like
 * features/textedit, edits apply immediately to the engine's document, so
 * there is nothing per-document to reload). Mirrors features/textedit/store.ts.
 */
export const useImageEditStore = create<ImageEditState>((set) => ({
  active: false,
  selected: null,

  toggleActive: () => set((s) => ({ active: !s.active })),
  select: (selected) => set({ selected }),

  reset: () => {
    clearLocatedImagesCache();
    set({ active: false, selected: null });
  },
}));
