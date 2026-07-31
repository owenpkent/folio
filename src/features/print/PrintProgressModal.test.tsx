import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PrintProgressModal } from './PrintProgressModal';
import { usePrintStore } from './store';

beforeEach(() => usePrintStore.getState().start(100));

afterEach(() => {
  cleanup();
  usePrintStore.getState().finish();
});

describe('PrintProgressModal', () => {
  it('cancels the run on Escape', () => {
    render(<PrintProgressModal />);

    expect(usePrintStore.getState().cancelRequested).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });

    // Escape is how every other modal in the app is dismissed, and this one is
    // on screen for as long as a long document takes to rasterize.
    expect(usePrintStore.getState().cancelRequested).toBe(true);
  });

  it('announces progress in steps instead of once per page', () => {
    const { container } = render(<PrintProgressModal />);
    const announced = () => container.querySelector('[aria-live="polite"]')?.textContent;

    act(() => usePrintStore.getState().setProgress(1));
    expect(announced()).toBe('Preparing to print, 0% done');

    // One announcement per page would queue 100 of them here, and the screen
    // reader would still be reading page 40 after the dialog had opened.
    act(() => usePrintStore.getState().setProgress(9));
    expect(announced()).toBe('Preparing to print, 0% done');

    act(() => usePrintStore.getState().setProgress(12));
    expect(announced()).toBe('Preparing to print, 10% done');
  });

  it('still shows the exact page on screen and on the progressbar', () => {
    render(<PrintProgressModal />);

    act(() => usePrintStore.getState().setProgress(37));

    const line = screen.getByText('Rendering page 37 of 100…');
    // Visible text only: the coarse live region above is what gets spoken.
    expect(line).not.toHaveAttribute('aria-live');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
  });
});
