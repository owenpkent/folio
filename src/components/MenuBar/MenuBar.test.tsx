import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';
import { useContributionStore } from '@/plugins';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { MenuBar } from './MenuBar';

/** MenuBar reads window.matchMedia (via useMediaQuery) to pick the desktop bar
    or the mobile hamburger. jsdom does not implement it, so stub a version
    that never matches: every test below wants the desktop bar. */
function stubMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const registeredIds: string[] = [];
function registerCommand(command: Parameters<typeof commandRegistry.register>[0]) {
  commandRegistry.register(command);
  registeredIds.push(command.id);
}

describe('MenuBar', () => {
  beforeEach(() => {
    stubMatchMedia();
    useDocumentStore.setState({ status: 'empty' });
    useViewerStore.setState({ sidebarOpen: false, handMode: false, autoScroll: false });
  });

  afterEach(() => {
    cleanup();
    registeredIds.splice(0).forEach((id) => commandRegistry.unregister(id));
    useContributionStore.setState({ toolbarItems: [] });
  });

  it('renders the top-level menus, with Tools absent when no plugin contributes one', () => {
    render(<MenuBar />);
    const bar = screen.getByRole('menubar', { name: 'Application menu' });
    for (const label of ['File', 'Edit', 'View', 'Annotate', 'Sign', 'Help']) {
      expect(within(bar).getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    expect(within(bar).queryByRole('menuitem', { name: 'Tools' })).not.toBeInTheDocument();
  });

  it('opens File on click and disables document-only actions with no document open', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));

    const menu = screen.getByRole('menu', { name: 'File' });
    expect(within(menu).getByRole('menuitem', { name: 'Open' })).toBeEnabled();
    expect(within(menu).getByRole('menuitem', { name: 'Save' })).toBeDisabled();
    expect(within(menu).getByRole('menuitem', { name: 'Save a copy' })).toBeDisabled();
  });

  it('shows a command shortcut sourced from the registry, and enables Save once a document opens', () => {
    registerCommand({
      id: 'file.save',
      title: 'Save',
      keybinding: 'Mod+S',
      when: () => useDocumentStore.getState().status === 'ready',
      run: vi.fn(),
    });
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));

    const save = screen.getByRole('menuitem', { name: 'Save' });
    expect(save).toHaveTextContent('Ctrl/Cmd + S');
    expect(save).toBeDisabled();

    act(() => useDocumentStore.setState({ status: 'ready' }));
    expect(screen.getByRole('menuitem', { name: 'Save' })).toBeEnabled();
  });

  it("reflects live viewer state on the View menu's checkable rows", () => {
    useViewerStore.setState({ sidebarOpen: true });
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));

    expect(screen.getByRole('menuitemcheckbox', { name: 'Sidebar' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Hand tool' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // Sidebar has no document guard, unlike Hand tool.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Sidebar' })).toBeEnabled();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Hand tool' })).toBeDisabled();
  });

  it('moves the roving tab stop with ArrowRight, sliding the open menu with it', () => {
    render(<MenuBar />);
    const file = screen.getByRole('menuitem', { name: 'File' });
    const edit = screen.getByRole('menuitem', { name: 'Edit' });

    file.focus();
    fireEvent.click(file);
    fireEvent.keyDown(file, { key: 'ArrowRight' });

    expect(edit).toHaveFocus();
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    expect(file).toHaveAttribute('aria-expanded', 'false');
    expect(file).toHaveAttribute('tabindex', '-1');
    expect(edit).toHaveAttribute('tabindex', '0');
  });

  it('ArrowDown opens a menu and focuses its first row', () => {
    render(<MenuBar />);
    const file = screen.getByRole('menuitem', { name: 'File' });
    file.focus();
    fireEvent.keyDown(file, { key: 'ArrowDown' });

    expect(screen.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
  });

  it('Escape inside an open menu closes it and returns focus to its trigger', () => {
    render(<MenuBar />);
    const file = screen.getByRole('menuitem', { name: 'File' });
    file.focus();
    fireEvent.click(file);
    const open = screen.getByRole('menuitem', { name: 'Open' });
    open.focus();

    fireEvent.keyDown(open, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'File' })).not.toBeInTheDocument();
    expect(file).toHaveFocus();
  });

  it("lists a plugin-contributed command in the Tools menu, disabled per its own command guard", () => {
    registerCommand({
      id: 'plugin.test.run',
      title: 'Test tool',
      when: () => useDocumentStore.getState().status === 'ready',
      run: vi.fn(),
    });
    act(() =>
      useContributionStore.getState().addToolbarItem({
        id: 'plugin.test.toolbar',
        title: 'Test Tool',
        commandId: 'plugin.test.run',
      }),
    );

    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tools' }));
    expect(screen.getByRole('menuitem', { name: 'Test Tool' })).toBeDisabled();

    act(() => useDocumentStore.setState({ status: 'ready' }));
    expect(screen.getByRole('menuitem', { name: 'Test Tool' })).toBeEnabled();
  });
});
