import { create } from 'zustand';

interface ContextMenuState {
  open: boolean;
  /** Viewport coordinates where the menu was requested. */
  x: number;
  y: number;
  /** Text selected when the menu opened (drives Copy / selection-only items). */
  selectionText: string;
  openMenu(x: number, y: number, selectionText: string): void;
  closeMenu(): void;
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  selectionText: '',
  openMenu: (x, y, selectionText) => set({ open: true, x, y, selectionText }),
  closeMenu: () => set({ open: false }),
}));
