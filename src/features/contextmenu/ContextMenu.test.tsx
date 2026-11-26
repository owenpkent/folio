import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDefaultCommands } from '@/commands/defaultCommands';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { ContextMenu } from './ContextMenu';
import { useContextMenu } from './store';

describe('ContextMenu auto-scroll item', () => {
  beforeEach(() => {
    registerDefaultCommands();
    useViewerStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useContextMenu.getState().closeMenu();
    useViewerStore.getState().reset();
    useDocumentStore.getState().reset();
  });

  it('turns auto-scroll on and off from the right-click menu', async () => {
    useDocumentStore.setState({ status: 'ready' });
    useContextMenu.getState().openMenu(10, 10, '');
    const { unmount } = render(<ContextMenu />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-scroll' }));
    await waitFor(() => expect(useViewerStore.getState().autoScroll).toBe(true));
    expect(useContextMenu.getState().open).toBe(false);
    unmount();

    useContextMenu.getState().openMenu(10, 10, '');
    render(<ContextMenu />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-scroll' }));
    await waitFor(() => expect(useViewerStore.getState().autoScroll).toBe(false));
  });

  it('is disabled without a document', () => {
    useContextMenu.getState().openMenu(10, 10, '');
    render(<ContextMenu />);
    expect(screen.getByRole('menuitem', { name: 'Auto-scroll' })).toBeDisabled();
  });
});

describe('ContextMenu placement', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useContextMenu.getState().closeMenu();
  });

  it('re-clamps into the window when the address row makes it taller', () => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(620);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(640);
    // jsdom lays nothing out: the menu is as tall as its rows say.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rows = this.querySelectorAll('[role="menuitem"]').length;
      return { width: 220, height: rows * 31 + 8 } as DOMRect;
    });
    useContextMenu.getState().openMenu(100, 145, '');
    render(<ContextMenu />);
    const menu = screen.getByRole('menu', { name: 'Document actions' });
    const bottom = () => parseFloat(menu.style.top) + menu.getBoundingClientRect().height;
    expect(bottom()).toBeLessThanOrEqual(620 - 8);

    act(() =>
      useContextMenu.getState().setTarget({
        kind: 'url',
        value: 'https://example.com/path/to/document.pdf',
        source: 'annotation',
      }),
    );
    expect(screen.getByRole('menuitem', { name: 'Copy link address' })).toBeInTheDocument();
    expect(bottom()).toBeLessThanOrEqual(620 - 8);
  });
});
