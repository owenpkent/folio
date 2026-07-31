import { create } from 'zustand';

export type UiTheme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
/** Which color scheme the page renders in when the UI is dark. */
export type DarkScheme = 'night' | 'green' | 'amber';

const THEME_KEY = 'folio.theme';
const DARK_SCHEME_KEY = 'folio.darkScheme';
const DARK_SCHEMES: DarkScheme[] = ['night', 'green', 'amber'];

/**
 * Page tint (RGB 0-255) multiplied over the inverted page for each dark scheme.
 * Night has no tint (plain white-on-black); Green/Amber colour the ink. Applied
 * at raster time in {@link PdfJsEngine.renderPage}.
 */
export const DARK_SCHEME_TINT: Record<DarkScheme, [number, number, number] | null> = {
  night: null,
  // The Linux console's bright ANSI green (#55FF55), so green-on-black pages
  // read like a terminal rather than a pastel.
  green: [85, 255, 85],
  amber: [240, 185, 80],
};

export const DARK_SCHEME_LABELS: Record<DarkScheme, string> = {
  night: 'Night',
  green: 'Green',
  amber: 'Amber',
};

/** Display names for the viewing mode. Shared rather than repeated per control
    because three surfaces (the toolbar's appearance menu, the More menu's
    cycling row, the View menu) both label and announce the same change, and a
    screen-reader user hearing two different sentences for it would have no way
    to tell they are the same setting. */
export const THEME_LABELS: Record<UiTheme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Match system',
};

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable (private mode); ignore */
  }
}

interface ThemeState {
  theme: UiTheme;
  resolvedTheme: ResolvedTheme;
  darkScheme: DarkScheme;

  setTheme(theme: UiTheme): void;
  toggleTheme(): void;
  setResolvedTheme(resolved: ResolvedTheme): void;
  setDarkScheme(scheme: DarkScheme): void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStored<UiTheme>(THEME_KEY, ['light', 'dark', 'system'], 'system'),
  resolvedTheme: 'light',
  darkScheme: readStored<DarkScheme>(DARK_SCHEME_KEY, DARK_SCHEMES, 'night'),

  setTheme: (theme) => {
    persist(THEME_KEY, theme);
    set({ theme });
  },
  toggleTheme: () => {
    const next: UiTheme = get().resolvedTheme === 'dark' ? 'light' : 'dark';
    persist(THEME_KEY, next);
    set({ theme: next });
  },
  setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),
  setDarkScheme: (darkScheme) => {
    persist(DARK_SCHEME_KEY, darkScheme);
    set({ darkScheme });
  },
}));
