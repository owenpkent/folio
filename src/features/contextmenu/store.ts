import { create } from 'zustand';

import type { CopyTarget } from '@/features/links';

interface ContextMenuState {
  open: boolean;
  /** Viewport coordinates where the menu was requested. */
  x: number;
  y: number;
  /** Text selected when the menu opened (drives Copy / selection-only items). */
  selectionText: string;
  /**
   * The email or web address the menu was opened over, if any. Resolved from
   * the page rather than from the DOM, so it is set for a link annotation the
   * annotation layer never gave pointer events to.
   */
  target: CopyTarget | null;
  openMenu(x: number, y: number, selectionText: string, target?: CopyTarget | null): void;
  closeMenu(): void;
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  selectionText: '',
  target: null,
  openMenu: (x, y, selectionText, target = null) =>
    set({ open: true, x, y, selectionText, target }),
  closeMenu: () => set({ open: false }),
}));
