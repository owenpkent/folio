import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ToastHost } from './ToastHost';
import { pushToast, useToastStore } from './toastStore';

describe('ToastHost', () => {
  afterEach(() => {
    cleanup();
    useToastStore.setState({ toasts: [] });
  });

  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastHost />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a pushed toast', () => {
    render(<ToastHost />);
    act(() => {
      pushToast('Saved');
    });
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });
});

describe('ToastHost action', () => {
  afterEach(() => {
    cleanup();
    useToastStore.setState({ toasts: [] });
  });

  it('renders a named button that runs the action and dismisses the toast', () => {
    const onClick = vi.fn();
    render(<ToastHost />);
    act(() => {
      pushToast('Resumed at page 47', 'info', { label: 'Start over', onClick });
    });
    const button = screen.getByRole('button', { name: 'Start over' });
    expect(button.tagName).toBe('BUTTON');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Resumed at page 47')).not.toBeInTheDocument();
  });

  it('shows no action button for a plain toast', () => {
    render(<ToastHost />);
    act(() => {
      pushToast('Saved');
    });
    expect(screen.queryByRole('button', { name: 'Start over' })).not.toBeInTheDocument();
  });

  it('gives an action toast longer to be reached than a plain one', () => {
    vi.useFakeTimers();
    try {
      pushToast('plain');
      pushToast('with action', 'info', { label: 'Go', onClick: () => {} });
      vi.advanceTimersByTime(4000);
      expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['with action']);
    } finally {
      vi.useRealTimers();
    }
  });
});
