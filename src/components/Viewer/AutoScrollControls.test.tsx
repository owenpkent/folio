import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTO_SCROLL_MAX, useViewerStore } from '@/state/viewerStore';
import { useDocumentStore } from '@/state/documentStore';

import { AutoScrollControls } from './AutoScrollControls';
import { clampPosition, readLayout, writeLayout } from './autoScrollLayout';

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

  it('pauses and resumes from the big button', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(useViewerStore.getState().autoScrollPaused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(useViewerStore.getState().autoScrollPaused).toBe(false);
  });

  it('changes speed and disables faster at the top speed', () => {
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
  });

  it('stops, and turning it back on starts playing, not paused', () => {
    useViewerStore.getState().setAutoScroll(true);
    useViewerStore.getState().toggleAutoScrollPaused();
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop auto-scroll' }));
    expect(useViewerStore.getState().autoScroll).toBe(false);
    useViewerStore.getState().toggleAutoScroll();
    expect(useViewerStore.getState().autoScrollPaused).toBe(false);
  });

  it('picks a size from the Size menu and remembers it', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    expect(screen.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Extra large' }));
    expect(readLayout().scale).toBe(2);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes the Size menu on Escape without stopping auto-scroll', () => {
    useViewerStore.getState().setAutoScroll(true);
    render(<AutoScrollControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Size' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(useViewerStore.getState().autoScroll).toBe(true);
  });
});

describe('autoScrollLayout', () => {
  afterEach(() => localStorage.clear());

  it('falls back to the default for missing, malformed or hostile storage', () => {
    expect(readLayout()).toEqual({ x: null, y: null, scale: 1 });
    localStorage.setItem('folio.autoScrollControls', '{not json');
    expect(readLayout().scale).toBe(1);
    localStorage.setItem('folio.autoScrollControls', JSON.stringify({ x: 'a', y: 5, scale: 99 }));
    expect(readLayout()).toEqual({ x: null, y: null, scale: 2 });
    localStorage.setItem('folio.autoScrollControls', JSON.stringify({ x: 1, y: 2, scale: 1.4 }));
    expect(readLayout()).toEqual({ x: 1, y: 2, scale: 1.5 });
  });

  it('round-trips a placed layout', () => {
    writeLayout({ x: 40, y: 300, scale: 1.5 });
    expect(readLayout()).toEqual({ x: 40, y: 300, scale: 1.5 });
  });

  it('keeps the bar inside the document area', () => {
    expect(clampPosition(-50, 900, 200, 80, 1000, 600)).toEqual({ x: 0, y: 520 });
    expect(clampPosition(950, 10, 200, 80, 1000, 600)).toEqual({ x: 800, y: 10 });
  });
});
