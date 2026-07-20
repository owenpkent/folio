import { beforeEach, describe, expect, it } from 'vitest';

import { useThemeStore } from './themeStore';

describe('themeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ theme: 'system', resolvedTheme: 'light' });
  });

  it('setTheme updates state and persists', () => {
    useThemeStore.getState().setTheme('dark');
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(localStorage.getItem('folio.theme')).toBe('dark');
  });

  it('toggleTheme flips relative to the resolved theme', () => {
    useThemeStore.getState().setResolvedTheme('dark');
    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('light');

    useThemeStore.getState().setResolvedTheme('light');
    useThemeStore.getState().toggleTheme();
    expect(useThemeStore.getState().theme).toBe('dark');
  });
});
