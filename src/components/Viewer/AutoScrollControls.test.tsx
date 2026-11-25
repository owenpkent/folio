import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('moves through the Size menu by keyboard without reaching the viewer handler', () => {
    useViewerStore.getState().setAutoScroll(true);
    const speed = useViewerStore.getState().autoScrollSpeed;
    // Stands in for the viewer's window-level handler (arrows change speed).
    const viewerKey = vi.fn();
    window.addEventListener('keydown', viewerKey);
    render(<AutoScrollControls />);
    const sizeBtn = screen.getByRole('button', { name: 'Size' });
    fireEvent.click(sizeBtn);
    const item = (name: string) => screen.getByRole('menuitemradio', { name });
    expect(item('Medium')).toHaveFocus();
    fireEvent.keyDown(item('Medium'), { key: 'ArrowDown' });
    expect(item('Large')).toHaveFocus();
    fireEvent.keyDown(item('Large'), { key: 'End' });
    expect(item('Extra large')).toHaveFocus();
    fireEvent.keyDown(item('Extra large'), { key: 'ArrowDown' });
    expect(item('Small')).toHaveFocus();
    fireEvent.keyDown(item('Small'), { key: 'ArrowUp' });
    expect(item('Extra large')).toHaveFocus();
    fireEvent.keyDown(item('Extra large'), { key: 'Home' });
    expect(item('Small')).toHaveFocus();
    expect(viewerKey).not.toHaveBeenCalled();
    expect(useViewerStore.getState().autoScrollSpeed).toBe(speed);
    // Escape closes, returns focus to the button, and leaves auto-scroll running.
    fireEvent.keyDown(item('Small'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sizeBtn).toHaveFocus();
    expect(useViewerStore.getState().autoScroll).toBe(true);
    // Tab closes it too.
    fireEvent.click(sizeBtn);
    fireEvent.keyDown(item('Medium'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(sizeBtn).toHaveFocus();
    window.removeEventListener('keydown', viewerKey);
  });

  it('opens the Size menu upward and caps its height when there is no room below', () => {
    useViewerStore.getState().setAutoScroll(true);
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top }) as DOMRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('folio-autoscroll__size')) return rect(400, 448);
        if (this.parentElement === document.body) return rect(0, 480);
        return rect(0, 0);
      });
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(190);
    try {
      render(<AutoScrollControls />);
      fireEvent.click(screen.getByRole('button', { name: 'Size' }));
      const menu = screen.getByRole('menu');
      expect(menu).toHaveClass('is-up');
      expect(menu.style.maxHeight).toBe('');
    } finally {
      spy.mockRestore();
      scroll.mockRestore();
    }
  });

  it('refits the placed bar when the document area resizes without a window resize', () => {
    writeLayout({ x: 500, y: 10, scale: 1 });
    useViewerStore.getState().setAutoScroll(true);
    let notify: () => void = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          notify = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    const w = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100);
    const h = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(50);
    let areaW = 1000;
    const cw = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(() => areaW);
    const ch = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
    try {
      render(<AutoScrollControls />);
      const bar = screen.getByRole('toolbar', { name: 'Auto-scroll controls' });
      expect(bar.style.left).toBe('500px');
      areaW = 300;
      act(() => notify());
      expect(bar.style.left).toBe('200px');
    } finally {
      w.mockRestore();
      h.mockRestore();
      cw.mockRestore();
      ch.mockRestore();
      vi.unstubAllGlobals();
    }
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
