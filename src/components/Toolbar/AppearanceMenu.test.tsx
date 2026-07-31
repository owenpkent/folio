import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { announce } from '@/a11y/announcer';
import { useThemeStore } from '@/theme/themeStore';

import { AppearanceMenu } from './AppearanceMenu';

// The live region writes on the next animation frame, which says nothing about
// whether the component asked for an announcement at all; assert the call.
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Appearance:/ }));
  return screen.getByRole('menu', { name: 'Appearance' });
};

describe('AppearanceMenu', () => {
  beforeEach(() => {
    vi.mocked(announce).mockClear();
    useThemeStore.setState({ theme: 'light', resolvedTheme: 'light', darkScheme: 'night' });
  });

  afterEach(cleanup);

  it('opens the menu from the trigger and closes it on a second click', () => {
    render(<AppearanceMenu />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    const trigger = screen.getByRole('button', { name: /^Appearance:/ });
    fireEvent.click(trigger);
    expect(screen.getByRole('menu', { name: 'Appearance' })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape and on a pointer press outside it', () => {
    render(<AppearanceMenu />);

    openMenu();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('announces the trigger as a menu button, not as a toggle', () => {
    render(<AppearanceMenu />);
    const trigger = screen.getByRole('button', { name: /^Appearance:/ });

    // aria-pressed would make this a toggle button whose pressed state tracks
    // popup visibility, which is what aria-expanded is for.
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).not.toHaveAttribute('aria-pressed');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('names the current mode and keeps the light / dark shortcut discoverable', () => {
    useThemeStore.setState({ theme: 'system' });
    render(<AppearanceMenu />);

    // IconButton names and tooltips a control from the same string, so the
    // hint reaches the hover tooltip and the accessible name together.
    const trigger = screen.getByRole('button', { name: /^Appearance: Match system/ });
    expect(trigger.getAttribute('aria-label')).toContain('Ctrl/Cmd + Shift + L');
    expect(trigger.getAttribute('title')).toContain('Ctrl/Cmd + Shift + L');
  });

  it('splits the two radio sets into named groups, one checked row in each', () => {
    // The state that exposed the bug: with both sets flattened into one menu a
    // screen reader read six radios with two of them checked.
    useThemeStore.setState({ theme: 'system', darkScheme: 'night' });
    render(<AppearanceMenu />);
    const menu = openMenu();

    const modes = within(menu).getByRole('group', { name: 'Viewing mode' });
    const schemes = within(menu).getByRole('group', { name: 'Dark reading color' });

    expect(within(modes).getAllByRole('menuitemradio')).toHaveLength(3);
    expect(within(schemes).getAllByRole('menuitemradio')).toHaveLength(3);

    const checkedCount = (group: HTMLElement) =>
      within(group)
        .getAllByRole('menuitemradio')
        .filter((row) => row.getAttribute('aria-checked') === 'true').length;
    expect(checkedCount(modes)).toBe(1);
    expect(checkedCount(schemes)).toBe(1);
    expect(within(modes).getByRole('menuitemradio', { name: 'Match system' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(schemes).getByRole('menuitemradio', { name: 'Night' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('labels each group from its own visible caption', () => {
    render(<AppearanceMenu />);
    const menu = openMenu();

    // The captions used to be role="presentation", naming neither set.
    const group = within(menu).getByRole('group', { name: 'Viewing mode' });
    const caption = document.getElementById(group.getAttribute('aria-labelledby') ?? '');
    expect(caption).toHaveTextContent('Viewing mode');
  });

  it('sets the viewing mode, announces it, and closes the menu', () => {
    render(<AppearanceMenu />);
    const menu = openMenu();

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Match system' }));

    expect(useThemeStore.getState().theme).toBe('system');
    expect(announce).toHaveBeenCalledWith('Viewing mode Match system');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('sets the dark reading colour and announces it', () => {
    render(<AppearanceMenu />);
    const menu = openMenu();

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Amber' }));

    expect(useThemeStore.getState().darkScheme).toBe('amber');
    expect(announce).toHaveBeenCalledWith('Dark reading color Amber');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
