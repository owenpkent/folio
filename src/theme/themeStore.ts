import { create } from 'zustand';

export type UiTheme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';
export type ReadingMode = 'normal' | 'night' | 'sepia' | 'high-contrast';

const THEME_KEY = 'folio.theme';
const READING_KEY = 'folio.readingMode';

const READING_MODES: ReadingMode[] = ['normal', 'night', 'sepia', 'high-contrast'];

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
  readingMode: ReadingMode;

  setTheme(theme: UiTheme): void;
  toggleTheme(): void;
  setResolvedTheme(resolved: ResolvedTheme): void;
  setReadingMode(mode: ReadingMode): void;
  cycleReadingMode(): void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: readStored<UiTheme>(THEME_KEY, ['light', 'dark', 'system'], 'system'),
  resolvedTheme: 'light',
  readingMode: readStored<ReadingMode>(READING_KEY, READING_MODES, 'normal'),

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
  setReadingMode: (mode) => {
    persist(READING_KEY, mode);
    set({ readingMode: mode });
  },
  cycleReadingMode: () => {
    const current = get().readingMode;
    const next = READING_MODES[(READING_MODES.indexOf(current) + 1) % READING_MODES.length];
    persist(READING_KEY, next);
    set({ readingMode: next });
  },
}));

export const READING_MODE_LABELS: Record<ReadingMode, string> = {
  normal: 'Normal',
  night: 'Night',
  sepia: 'Sepia',
  'high-contrast': 'High contrast',
};
