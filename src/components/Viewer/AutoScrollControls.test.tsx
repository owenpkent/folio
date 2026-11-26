import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_SCROLL_MAX, AUTO_SCROLL_MIN, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { AutoScrollControls } from './AutoScrollControls';
import { readLayout, writeLayout } from './autoScrollLayout';

const KEY = 'folio.autoScrollControls';

describe('AutoScrollControls', () => {
  beforeEach(() => {
    useDocumentStore.setState({ status: 'ready' });
    useViewerStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    useViewerStore.getState().reset();
    useDocumentStore.setState({ status: 'empty' });
  });

  it('is hidden while auto-scroll is off', () => {
    render(<AutoScrollControls />);
    expect(screen.queryByRole('toolbar', { name: 'Auto-scroll controls' })).toBeNull();
  });

  it('shows the puck with slower and faster under it, and nothing else', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    const bar = screen.getByRole('toolbar', { name: 'Auto-scroll controls' });
    expect(screen.getAllByRole('button').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Pause',
      'Slower',
      'Faster',
    ]);
    expect(bar.textContent).toBe('');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('pauses and resumes from the puck', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(useViewerStore.getState().autoScrollPaused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(useViewerStore.getState().autoScrollPaused).toBe(false);
  });

  it('changes speed and disables slower and faster at the limits', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    const before = useViewerStore.getState().autoScrollSpeed;
    fireEvent.click(screen.getByRole('button', { name: 'Faster' }));
    expect(useViewerStore.getState().autoScrollSpeed).toBeGreaterThan(before);
    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    fireEvent.click(screen.getByRole('button', { name: 'Slower' }));
    expect(useViewerStore.getState().autoScrollSpeed).toBeLessThan(before);
    act(() => useViewerStore.getState().setAutoScrollSpeed(AUTO_SCROLL_MAX));
    expect(screen.getByRole('button', { name: 'Faster' })).toBeDisabled();
    act(() => useViewerStore.getState().setAutoScrollSpeed(AUTO_SCROLL_MIN));
    expect(screen.getByRole('button', { name: 'Slower' })).toBeDisabled();
  });

  it('opens a size menu on right-click with the current size checked and focused', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    const notPrevented = fireEvent.contextMenu(screen.getByRole('button', { name: 'Pause' }), {
      clientX: 300,
      clientY: 200,
    });
    // false: the native menu was suppressed.
    expect(notPrevented).toBe(false);
    const menu = screen.getByRole('menu', { name: 'Size of auto-scroll controls' });
    expect(screen.getAllByRole('menuitemradio').map((el) => el.textContent)).toEqual([
      'Small',
      'Medium',
      'Large',
      'Extra large',
    ]);
    const medium = screen.getByRole('menuitemradio', { name: 'Medium' });
    expect(medium).toHaveAttribute('aria-checked', 'true');
    expect(medium).toHaveFocus();
    expect(menu).toContainElement(medium);
  });

  it('opens the menu from a right-click on the box between the buttons too', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.contextMenu(screen.getByRole('toolbar', { name: 'Auto-scroll controls' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('sets the size from the menu, closes it, hands focus back, and remembers it', () => {
    useViewerStore.getState().setAutoScroll(true);
    const { unmount } = render(<AutoScrollControls />);
    const puck = screen.getByRole('button', { name: 'Pause' });
    puck.focus();
    fireEvent.contextMenu(puck, { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Extra large' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(puck).toHaveFocus();
    expect(readLayout()).toEqual({ scale: 2 });
    const bar = screen.getByRole('toolbar', { name: 'Auto-scroll controls' });
    expect(bar.style.getPropertyValue('--folio-as-scale')).toBe('2');
    unmount();

    render(<AutoScrollControls />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByRole('menuitemradio', { name: 'Extra large' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('moves through the menu with the arrow keys without changing speed', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    const speed = useViewerStore.getState().autoScrollSpeed;
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Pause' }));
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'Large' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitemradio', { name: 'Extra large' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'Small' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitemradio', { name: 'Extra large' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitemradio', { name: 'Small' })).toHaveFocus();
    expect(useViewerStore.getState().autoScrollSpeed).toBe(speed);
  });

  it('closes on Escape without stopping auto-scroll', () => {
    useViewerStore.getState().setAutoScroll(true);
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      render(<AutoScrollControls />);
      fireEvent.contextMenu(screen.getByRole('button', { name: 'Pause' }));
      fireEvent.keyDown(screen.getByRole('menuitemradio', { name: 'Medium' }), {
        key: 'Escape',
      });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onWindowKey).not.toHaveBeenCalled();
      expect(useViewerStore.getState().autoScroll).toBe(true);
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it('closes on a press outside the menu', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('never opens anything on hover or closes the menu on a timer', () => {
    vi.useFakeTimers();
    try {
      useViewerStore.getState().setAutoScroll(true);
      render(<AutoScrollControls />);
      const puck = screen.getByRole('button', { name: 'Pause' });
      fireEvent.mouseEnter(puck);
      fireEvent.pointerEnter(puck);
      fireEvent.mouseOver(puck);
      expect(screen.queryByRole('menu')).toBeNull();
      fireEvent.contextMenu(puck);
      act(() => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      expect(screen.getByRole('menu')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('autoScrollLayout', () => {
  afterEach(() => localStorage.clear());

  it('falls back to the default for missing, malformed or hostile storage', () => {
    const defaults = { scale: 1 };
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, '{not json');
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, 'null');
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ scale: 99 }));
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ scale: '2' }));
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ scale: 1.4 }));
    expect(readLayout()).toEqual(defaults);
  });

  it('reads legacy data cleanly, ignoring the old position and panel state', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 40, y: 300, scale: 1.5 }));
    expect(readLayout()).toEqual({ scale: 1.5 });
    localStorage.setItem(KEY, JSON.stringify({ scale: 0.75, expanded: true }));
    expect(readLayout()).toEqual({ scale: 0.75 });
  });

  it('round-trips the layout', () => {
    writeLayout({ scale: 0.75 });
    expect(readLayout()).toEqual({ scale: 0.75 });
  });
});
