import { create } from 'zustand';

export type FitMode = 'custom' | 'width' | 'page';
export type SidebarTab = 'thumbnails' | 'outline' | 'annotations' | (string & {});

interface ViewerState {
  /** Current render scale (1 = 100%). */
  scale: number;
  fitMode: FitMode;
  /** 1-based page currently in view. */
  currentPage: number;
  numPages: number;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  searchOpen: boolean;
  signatureModalOpen: boolean;
  /** Set when something requests a scroll-to-page; the viewer clears it. */
  pendingScrollPage: number | null;

  setScale(scale: number): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  setFitMode(mode: FitMode): void;
  setNumPages(n: number): void;
  setCurrentPage(n: number): void;
  goToPage(n: number): void;
  toggleSidebar(): void;
  setSidebarOpen(open: boolean): void;
  setSidebarTab(tab: SidebarTab): void;
  toggleSearch(): void;
  setSearchOpen(open: boolean): void;
  setSignatureModalOpen(open: boolean): void;
  clearPendingScroll(): void;
  reset(): void;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
const ZOOM_STEP = 1.2;

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export const useViewerStore = create<ViewerState>((set, get) => ({
  scale: 1.2,
  fitMode: 'width',
  currentPage: 1,
  numPages: 0,
  sidebarOpen: true,
  sidebarTab: 'thumbnails',
  searchOpen: false,
  signatureModalOpen: false,
  pendingScrollPage: null,

  setScale: (scale) => set({ scale: clampScale(scale), fitMode: 'custom' }),
  zoomIn: () => set({ scale: clampScale(get().scale * ZOOM_STEP), fitMode: 'custom' }),
  zoomOut: () => set({ scale: clampScale(get().scale / ZOOM_STEP), fitMode: 'custom' }),
  resetZoom: () => set({ scale: 1, fitMode: 'custom' }),
  setFitMode: (fitMode) => set({ fitMode }),
  setNumPages: (numPages) => set({ numPages }),
  setCurrentPage: (currentPage) => set({ currentPage }),
  goToPage: (n) => {
    const { numPages } = get();
    const page = Math.min(Math.max(1, Math.round(n)), Math.max(1, numPages));
    set({ currentPage: page, pendingScrollPage: page });
  },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab, sidebarOpen: true }),
  toggleSearch: () => set((s) => ({ searchOpen: !s.searchOpen })),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSignatureModalOpen: (signatureModalOpen) => set({ signatureModalOpen }),
  clearPendingScroll: () => set({ pendingScrollPage: null }),
  reset: () =>
    set({
      scale: 1.2,
      fitMode: 'width',
      currentPage: 1,
      numPages: 0,
      searchOpen: false,
      signatureModalOpen: false,
      pendingScrollPage: null,
    }),
}));
