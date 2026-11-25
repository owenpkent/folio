import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_SCROLL_MAX, AUTO_SCROLL_MIN, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { AutoScrollControls } from './AutoScrollControls';
import { readLayout, writeLayout } from './autoScrollLayout';

const KEY = 'folio.autoScrollControls';
const MORE = { name: 'More auto-scroll controls' };
const FEWER = { name: 'Fewer auto-scroll controls' };

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

  it('shows only the puck and the chevron until expanded', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.getByRole('button', MORE)).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Faster' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Size' })).toBeNull();
  });

  it('pauses and resumes from the puck, announcing each', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(useViewerStore.getState().autoScrollPaused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(useViewerStore.getState().autoScrollPaused).toBe(false);
  });

  it('expands and collapses on click, and remembers it', () => {
    useViewerStore.getState().setAutoScroll(true);
    const { unmount } = render(<AutoScrollControls />);
    const toggle = screen.getByRole('button', MORE);
    fireEvent.click(toggle);
    const open = screen.getByRole('button', FEWER);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(open.getAttribute('aria-controls')).toBe(
      screen.getByRole('button', { name: 'Faster' }).closest('.folio-autoscroll__panel')?.id,
    );
    expect(readLayout().expanded).toBe(true);
    unmount();

    render(<AutoScrollControls />);
    expect(screen.getByRole('button', FEWER)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', FEWER));
    expect(screen.queryByRole('button', { name: 'Faster' })).toBeNull();
    expect(readLayout().expanded).toBe(false);
  });

  it('never expands on hover or collapses on a timer', () => {
    vi.useFakeTimers();
    try {
      useViewerStore.getState().setAutoScroll(true);
      render(<AutoScrollControls />);
      const toggle = screen.getByRole('button', MORE);
      fireEvent.mouseEnter(toggle);
      fireEvent.pointerEnter(toggle);
      fireEvent.mouseOver(toggle);
      expect(screen.queryByRole('button', { name: 'Faster' })).toBeNull();
      fireEvent.click(toggle);
      act(() => {
        vi.advanceTimersByTime(10 * 60 * 1000);
      });
      expect(screen.getByRole('button', { name: 'Faster' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes speed and disables slower and faster at the limits', () => {
    writeLayout({ scale: 1, expanded: true });
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

  it('stops, and turning it back on starts playing, not paused', () => {
    writeLayout({ scale: 1, expanded: true });
    useViewerStore.getState().setAutoScroll(true);
    useViewerStore.getState().toggleAutoScrollPaused();
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop auto-scroll' }));
    expect(useViewerStore.getState().autoScroll).toBe(false);
    useViewerStore.getState().toggleAutoScroll();
    expect(useViewerStore.getState().autoScrollPaused).toBe(false);
  });

  it('sets the size from S / M / L / XL buttons, with aria-pressed, and remembers it', () => {
    writeLayout({ scale: 1, expanded: true });
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    const group = screen.getByRole('group', { name: 'Size' });
    const names = ['Small', 'Medium', 'Large', 'Extra large'];
    for (const name of names) {
      expect(group).toContainElement(screen.getByRole('button', { name }));
    }
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Extra large' }));
    expect(screen.getByRole('button', { name: 'Extra large' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'false');
    expect(readLayout()).toEqual({ scale: 2, expanded: true });
    const bar = screen.getByRole('toolbar', { name: 'Auto-scroll controls' });
    expect(bar.style.getPropertyValue('--folio-as-scale')).toBe('2');
    // The panel stays open after choosing a size.
    expect(screen.getByRole('button', FEWER)).toBeInTheDocument();
  });

  it('has no popup menu', () => {
    writeLayout({ scale: 1, expanded: true });
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('autoScrollLayout', () => {
  afterEach(() => localStorage.clear());

  it('falls back to the defaults for missing, malformed or hostile storage', () => {
    const defaults = { scale: 1, expanded: false };
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, '{not json');
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, 'null');
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ scale: 99, expanded: 'yes' }));
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ scale: '2', expanded: 1 }));
    expect(readLayout()).toEqual(defaults);
    localStorage.setItem(KEY, JSON.stringify({ scale: 1.4, expanded: true }));
    expect(readLayout()).toEqual({ scale: 1, expanded: true });
  });

  it('reads legacy data with x and y cleanly, ignoring the position', () => {
    localStorage.setItem(KEY, JSON.stringify({ x: 40, y: 300, scale: 1.5 }));
    expect(readLayout()).toEqual({ scale: 1.5, expanded: false });
  });

  it('round-trips the layout', () => {
    writeLayout({ scale: 0.75, expanded: true });
    expect(readLayout()).toEqual({ scale: 0.75, expanded: true });
  });
});
