import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  afterEach(() => {
    // Unmount as well as unregister: the hook's listener is on window, so a
    // leaked one from an earlier test would dispatch the next test's command
    // a second time.
    cleanup();
    commandRegistry.unregister('test.kb');
  });

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

  it('routes print to the command even while typing in a text field', () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.kb', title: 'T', keybinding: 'Mod+P', run });
    renderHook(() => useKeyboardShortcuts());

    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    // Falling through hands the browser's own Ctrl+P a DOM with the app's UI
    // hidden by the print stylesheet and no print root in it: a blank sheet,
    // no error, no way for the user to tell what happened.
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    input.remove();
  });

  it('swallows OS key repeat for a one-shot command', () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.kb', title: 'T', keybinding: 'Mod+P', run });
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true }));
    // Holding the chord repeats it about thirty times a second.
    const repeats = Array.from({ length: 5 }, () => {
      const e = new KeyboardEvent('keydown', {
        key: 'p',
        ctrlKey: true,
        repeat: true,
        cancelable: true,
      });
      window.dispatchEvent(e);
      return e;
    });

    expect(run).toHaveBeenCalledTimes(1);
    // Swallowed, not passed on: the browser acting on a repeated Ctrl+P is the
    // native dialog the command exists to replace.
    expect(repeats.every((e) => e.defaultPrevented)).toBe(true);
  });

  it('still lets a held navigation key repeat', () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.kb', title: 'T', keybinding: 'PageDown', run });
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', repeat: true }));

    // Holding PageDown to page through a document has to keep working.
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('still lets a held modified chord repeat when the command steps', () => {
    const run = vi.fn();
    commandRegistry.register({ id: 'test.kb', title: 'T', keybinding: 'Mod+z', run });
    renderHook(() => useKeyboardShortcuts());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, repeat: true }));

    // Undo and the zoom steps walk a history one step per press, so holding
    // them has to keep stepping; the repeat guard is aimed at one-shot actions.
    expect(run).toHaveBeenCalledTimes(2);
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
