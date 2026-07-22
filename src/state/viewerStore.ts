import { create } from 'zustand';

import { isNarrowViewport } from '@/theme/breakpoints';

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
  aboutModalOpen: boolean;
  /** Hand (pan) tool: click-drag scrolls the document instead of selecting text. */
  handMode: boolean;
  /** Auto-scroll (teleprompter): the document scrolls down on its own. */
  autoScroll: boolean;
  /** Auto-scroll speed in pixels per second. */
  autoScrollSpeed: number;
  /** Set when something requests a scroll-to-page; the viewer clears it. */
  pendingScrollPage: number | null;
  /** Bumped to force pages to re-rasterise (e.g. devicePixelRatio changed). */
  renderNonce: number;

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
  setAboutModalOpen(open: boolean): void;
  toggleHandMode(): void;
  setHandMode(on: boolean): void;
  toggleAutoScroll(): void;
  setAutoScroll(on: boolean): void;
  setAutoScrollSpeed(px: number): void;
  /** Multiply the current speed (e.g. 1.3 to speed up, 1/1.3 to slow down). */
  adjustAutoScrollSpeed(factor: number): void;
  clearPendingScroll(): void;
  bumpRenderNonce(): void;
  reset(): void;
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 8;
// Clean preset zoom levels the +/- controls snap to, so the readout shows tidy
// percentages (50, 100, 125, 150, 200…) instead of whatever a fit computed.
const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];

// Pixels per second. Skewed slow: the floor is a gentle reading crawl and even
// the top speed is a calm auto-advance rather than a fling. The toolbar slider
// maps its travel onto this range geometrically (see Toolbar), so the lower,
// slower speeds get most of the slider.
export const AUTO_SCROLL_MIN = 4;
export const AUTO_SCROLL_MAX = 160;
export const AUTO_SCROLL_DEFAULT = 12;

const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
const clampSpeed = (s: number): number =>
  Math.min(AUTO_SCROLL_MAX, Math.max(AUTO_SCROLL_MIN, Math.round(s)));

export const useViewerStore = create<ViewerState>((set, get) => ({
  scale: 1.2,
  fitMode: 'width',
  currentPage: 1,
  numPages: 0,
  // Phone-narrow windows start with the drawer closed: there it overlays the
  // document rather than sitting beside it.
  sidebarOpen: !isNarrowViewport(),
  sidebarTab: 'thumbnails',
  searchOpen: false,
  signatureModalOpen: false,
  aboutModalOpen: false,
  handMode: false,
  autoScroll: false,
  autoScrollSpeed: AUTO_SCROLL_DEFAULT,
  pendingScrollPage: null,
  renderNonce: 0,

  setScale: (scale) => set({ scale: clampScale(scale), fitMode: 'custom' }),
  zoomIn: () => {
    const s = get().scale;
    const next = ZOOM_LEVELS.find((z) => z > s + 1e-3) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    set({ scale: clampScale(next), fitMode: 'custom' });
  },
  zoomOut: () => {
    const s = get().scale;
    let next = ZOOM_LEVELS[0];
    for (let i = ZOOM_LEVELS.length - 1; i >= 0; i--) {
      if (ZOOM_LEVELS[i] < s - 1e-3) {
        next = ZOOM_LEVELS[i];
        break;
      }
    }
    set({ scale: clampScale(next), fitMode: 'custom' });
  },
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
  setAboutModalOpen: (aboutModalOpen) => set({ aboutModalOpen }),
  toggleHandMode: () => set((s) => ({ handMode: !s.handMode })),
  setHandMode: (handMode) => set({ handMode }),
  toggleAutoScroll: () => set((s) => ({ autoScroll: !s.autoScroll })),
  setAutoScroll: (autoScroll) => set({ autoScroll }),
  setAutoScrollSpeed: (px) => set({ autoScrollSpeed: clampSpeed(px) }),
  adjustAutoScrollSpeed: (factor) =>
    set((s) => ({ autoScrollSpeed: clampSpeed(s.autoScrollSpeed * factor) })),
  clearPendingScroll: () => set({ pendingScrollPage: null }),
  bumpRenderNonce: () => set((s) => ({ renderNonce: s.renderNonce + 1 })),
  reset: () =>
    set({
      scale: 1.2,
      fitMode: 'width',
      currentPage: 1,
      numPages: 0,
      searchOpen: false,
      signatureModalOpen: false,
      handMode: false,
      autoScroll: false,
      autoScrollSpeed: AUTO_SCROLL_DEFAULT,
      pendingScrollPage: null,
    }),
}));
