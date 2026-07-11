import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pushToast, useToastStore } from './toastStore';

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('push adds a toast and returns its id', () => {
    const id = pushToast('hello', 'success');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('hello');
    expect(toasts[0].kind).toBe('success');
    expect(toasts[0].id).toBe(id);
  });

  it('auto-dismisses after the timeout', () => {
    pushToast('bye');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismiss removes a specific toast', () => {
    const a = pushToast('a');
    pushToast('b');
    useToastStore.getState().dismiss(a);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['b']);
  });
});
