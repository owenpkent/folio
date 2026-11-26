import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
