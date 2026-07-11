import { beforeEach, describe, expect, it } from 'vitest';

import { READING_MODE_LABELS, useThemeStore } from './themeStore';

describe('themeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useThemeStore.setState({ theme: 'system', resolvedTheme: 'light', readingMode: 'normal' });
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

  it('cycleReadingMode cycles through every mode and persists', () => {
    const order = ['night', 'sepia', 'high-contrast', 'normal'];
    for (const expected of order) {
      useThemeStore.getState().cycleReadingMode();
      expect(useThemeStore.getState().readingMode).toBe(expected);
    }
    expect(localStorage.getItem('folio.readingMode')).toBe('normal');
  });

  it('exposes a label for each reading mode', () => {
    expect(READING_MODE_LABELS.normal).toBeTruthy();
    expect(READING_MODE_LABELS['high-contrast']).toBeTruthy();
  });
});
