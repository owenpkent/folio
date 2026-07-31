import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { useContributionStore } from '@/plugins';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';
import { useThemeStore } from '@/theme/themeStore';

import { MenuBar } from './MenuBar';

// The live region writes on the next animation frame, which says nothing about
// whether the menu asked for an announcement at all; assert the call.
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

/** MenuBar reads window.matchMedia (via useMediaQuery) to pick the desktop bar
    or the mobile hamburger. jsdom does not implement it, so stub one. Defaults
    to never matching, i.e. the desktop bar, which is what most tests want; the
    mobile block at the bottom of this file opts in. */
function stubMatchMedia(matches = false) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
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
    useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', darkScheme: 'night' });
    vi.mocked(announce).mockClear();
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
    expect(within(menu).getByRole('menuitem', { name: 'Print…' })).toBeDisabled();
  });

  it('offers Print in the File menu with its registry shortcut, enabled once a document opens', () => {
    registerCommand({
      id: 'file.print',
      title: 'Print',
      keybinding: 'Mod+P',
      when: () => useDocumentStore.getState().status === 'ready',
      run: vi.fn(),
    });
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }));

    const print = screen.getByRole('menuitem', { name: 'Print…' });
    expect(print).toHaveTextContent('Ctrl/Cmd + P');
    expect(print).toBeDisabled();

    act(() => useDocumentStore.setState({ status: 'ready' }));
    expect(screen.getByRole('menuitem', { name: 'Print…' })).toBeEnabled();
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

  it('offers Match system in the View menu, the only surface with the full keyboard pattern', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));

    const matchSystem = screen.getByRole('menuitemcheckbox', { name: 'Match system' });
    expect(matchSystem).toHaveAttribute('aria-checked', 'false');

    // The light/dark toggle alternates two modes and can never land on the
    // third, so this row is the only keyboard route to it.
    fireEvent.click(matchSystem);
    expect(useThemeStore.getState().theme).toBe('system');
  });

  it('pins the resolved theme when Match system is switched back off', () => {
    useThemeStore.setState({ theme: 'system', resolvedTheme: 'dark' });
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));

    const matchSystem = screen.getByRole('menuitemcheckbox', { name: 'Match system' });
    expect(matchSystem).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(matchSystem);
    expect(useThemeStore.getState().theme).toBe('dark');
  });

  it('announces a dark reading color picked from the View menu', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View' }));

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Amber' }));

    expect(useThemeStore.getState().darkScheme).toBe('amber');
    // The menu bar is the keyboard surface, so a silent change here is a
    // change a screen-reader user cannot hear at all. Same wording the
    // toolbar's appearance menu uses.
    expect(announce).toHaveBeenCalledWith('Dark reading color Amber');
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

  it('lists a plugin-contributed command in the Tools menu, disabled per its own command guard', () => {
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

  it('slides the open menu on hover without moving focus off the row being read', () => {
    render(<MenuBar />);
    const file = screen.getByRole('menuitem', { name: 'File' });
    const edit = screen.getByRole('menuitem', { name: 'Edit' });

    file.focus();
    fireEvent.click(file);
    const open = screen.getByRole('menuitem', { name: 'Open' });
    open.focus();

    // A pointer merely crossing the bar slides the open menu, the way a native
    // menu bar moves its highlight -- but it must not yank DOM focus, which
    // would strand a keyboard or screen-reader user mid-row.
    fireEvent.mouseEnter(edit);
    expect(edit).toHaveAttribute('aria-expanded', 'true');
    expect(file).toHaveAttribute('aria-expanded', 'false');
    expect(edit).not.toHaveFocus();
  });

  it('keeps the roving tab stop on one trigger only, so the bar is a single tab stop', () => {
    render(<MenuBar />);
    const triggers = within(screen.getByRole('menubar')).getAllByRole('menuitem');
    expect(triggers.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('takes the positioning wrapper out of the accessibility tree', () => {
    // A menubar may only own menuitem / menuitemcheckbox / menuitemradio /
    // group / separator. The div that positions each dropdown sits between the
    // two, so it carries role="none" or the ownership (and the "item 2 of 7"
    // set semantics a screen reader derives from it) is broken.
    render(<MenuBar />);
    const trigger = screen.getByRole('menuitem', { name: 'File' });
    expect(trigger.parentElement).toHaveAttribute('role', 'none');
  });
});

describe('MenuBar (narrow viewport)', () => {
  beforeEach(() => {
    stubMatchMedia(true);
    useDocumentStore.setState({ status: 'ready' });
    useViewerStore.setState({ sidebarOpen: false, handMode: false, autoScroll: false });
  });

  afterEach(() => {
    cleanup();
    useContributionStore.setState({ toolbarItems: [] });
  });

  it('collapses to one hamburger holding every command, grouped by menu', () => {
    render(<MenuBar />);
    expect(screen.queryByRole('menubar')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const menu = screen.getByRole('menu', { name: 'Menu' });
    expect(within(menu).getByRole('menuitem', { name: 'Save a copy' })).toBeInTheDocument();
    expect(within(menu).getByRole('group', { name: 'File' })).toBeInTheDocument();
  });

  it('navigates the flat dropdown with the arrow keys, as its menu role promises', () => {
    render(<MenuBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const menu = screen.getByRole('menu', { name: 'Menu' });

    // Focus is still on the hamburger, so the first ArrowDown enters the list
    // at its top rather than doing nothing.
    const rows = within(menu).getAllByRole('menuitem');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(rows[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(rows[1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(rows[0]).toHaveFocus();

    // Wraps backwards off the top to the last row, and End jumps there too.
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    const last = document.activeElement;
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(menu, { key: 'Home' });
    expect(rows[0]).toHaveFocus();
  });
});
