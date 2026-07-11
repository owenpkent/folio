import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  afterEach(() => commandRegistry.unregister('test.kb'));

  it('runs a command when its chord is pressed', () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.kb', title: 'T', keybinding: 'Mod+k', run });
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not hijack shortcuts while typing in an input', () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.kb', title: 'T', keybinding: 'Mod+k', run });
    renderHook(() => useKeyboardShortcuts());

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));

    expect(run).not.toHaveBeenCalled();
    input.remove();
  });

  it('does not run a command whose when() is false', () => {
    const run = vi.fn();
    commandRegistry.register({
      id: 'test.kb',
      title: 'T',
      keybinding: 'Mod+k',
      when: () => false,
      run,
    });
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    expect(run).not.toHaveBeenCalled();
  });
});
