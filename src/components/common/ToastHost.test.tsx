import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

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
