import { useEffect, type ReactNode } from 'react';

import { useThemeStore } from './themeStore';

/**
 * Applies the resolved UI theme and page reading mode to the document root.
 *
 * - `data-theme` drives the CSS custom properties in `theme/tokens.css`.
 * - `data-reading-mode` drives the page-canvas filters.
 *
 * When the UI theme is "system" it tracks `prefers-color-scheme` live.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
  const readingMode = useThemeStore((s) => s.readingMode);
  const setResolvedTheme = useThemeStore((s) => s.setResolvedTheme);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const resolved = theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', resolved);
      setResolvedTheme(resolved);
    };

    apply();
    if (theme === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [theme, setResolvedTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-reading-mode', readingMode);
  }, [readingMode]);

  return <>{children}</>;
}
