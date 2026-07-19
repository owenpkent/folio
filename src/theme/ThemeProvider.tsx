import { useEffect, type ReactNode } from 'react';

import { useThemeStore } from './themeStore';

/**
 * Applies the resolved UI theme to the document root.
 *
 * `data-theme` drives the CSS custom properties in `theme/tokens.css`, and in
 * dark mode also inverts the page canvas (one unified dark experience). When the
 * UI theme is "system" it tracks `prefers-color-scheme` live.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useThemeStore((s) => s.theme);
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

  return <>{children}</>;
}
