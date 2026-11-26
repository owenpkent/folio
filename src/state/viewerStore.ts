import { create } from 'zustand';

import { isNarrowViewport } from '@/theme/breakpoints';

export type FitMode = 'custom' | 'width' | 'page';
/** Every FitMode, for validating a value read back from storage. */
export const FIT_MODES: readonly FitMode[] = ['custom', 'width', 'page'];
type SidebarTab = 'thumbnails' | 'outline' | 'annotations' | (string & {});

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
  /** Auto-scroll is on but held still; play resumes from the same spot. */
  autoScrollPaused: boolean;
  /**
   * Auto-scroll speed in pixels per second, signed: positive scrolls down,
   * negative scrolls up. Its size is always within AUTO_SCROLL_MIN..MAX.
   */
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
  toggleAutoScrollPaused(): void;
  setAutoScrollSpeed(px: number): void;
  /**
   * One step of the slower/faster controls. A factor above 1 moves the speed
   * toward faster-downward (1.3: one step), below 1 toward faster-upward. The
   * speed passes through zero: one step slower from the slowest downward
   * speed is the slowest upward speed, and the other way round.
   */
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
// the top speed is a calm auto-advance rather than a fling. The − and + buttons
// and the arrow keys step it geometrically (see stepAutoScrollSpeed), so the
// slow end, where fine control matters, gets the finer steps.
export const AUTO_SCROLL_MIN = 4;
export const AUTO_SCROLL_MAX = 160;
const AUTO_SCROLL_DEFAULT = 12;

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
/** Keeps the direction and clamps the size; zero (or NaN) becomes slowest down. */
const clampSpeed = (s: number): number => {
  const size = Math.min(AUTO_SCROLL_MAX, Math.max(AUTO_SCROLL_MIN, Math.round(Math.abs(s))));
  return s < 0 ? -size : size;
};

/** The next speed after one step toward down (factor > 1) or up (factor < 1). */
export function stepAutoScrollSpeed(speed: number, factor: number): number {
  const towardDown = factor > 1;
  const ratio = towardDown ? factor : 1 / factor;
  if (!Number.isFinite(ratio) || ratio <= 1) return clampSpeed(speed);
  const goingDown = speed > 0;
  // Moving the way it already goes: faster. Against it: slower, and from the
  // slowest speed, over to the slowest speed the other way.
  if (goingDown === towardDown) return clampSpeed(speed * ratio);
  if (Math.abs(speed) <= AUTO_SCROLL_MIN) return towardDown ? AUTO_SCROLL_MIN : -AUTO_SCROLL_MIN;
  return clampSpeed(speed / ratio);
}

/** "12 pixels per second, down", for announcements. */
export const describeAutoScrollSpeed = (speed: number): string =>
  `${Math.abs(speed)} pixels per second, ${speed < 0 ? 'up' : 'down'}`;

/** What a freshly opened document starts at; also what reset() restores. */
export const DEFAULT_SCALE = 1.2;
export const DEFAULT_FIT_MODE: FitMode = 'width';

export const useViewerStore = create<ViewerState>((set, get) => ({
  scale: DEFAULT_SCALE,
  fitMode: DEFAULT_FIT_MODE,
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
  autoScrollPaused: false,
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
  // Turning auto-scroll on or off always starts it playing, never paused.
  toggleAutoScroll: () => set((s) => ({ autoScroll: !s.autoScroll, autoScrollPaused: false })),
  setAutoScroll: (autoScroll) => set({ autoScroll, autoScrollPaused: false }),
  toggleAutoScrollPaused: () => set((s) => ({ autoScrollPaused: !s.autoScrollPaused })),
  setAutoScrollSpeed: (px) => set({ autoScrollSpeed: clampSpeed(px) }),
  adjustAutoScrollSpeed: (factor) =>
    set((s) => ({ autoScrollSpeed: stepAutoScrollSpeed(s.autoScrollSpeed, factor) })),
  clearPendingScroll: () => set({ pendingScrollPage: null }),
  bumpRenderNonce: () => set((s) => ({ renderNonce: s.renderNonce + 1 })),
  reset: () =>
    set({
      scale: DEFAULT_SCALE,
      fitMode: DEFAULT_FIT_MODE,
      currentPage: 1,
      numPages: 0,
      searchOpen: false,
      signatureModalOpen: false,
      handMode: false,
      autoScroll: false,
      autoScrollPaused: false,
      autoScrollSpeed: AUTO_SCROLL_DEFAULT,
      pendingScrollPage: null,
    }),
}));
