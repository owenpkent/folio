import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  action?: ToastAction;
}

/** One optional button on a toast, for a follow-up the reader may want right now. */
export interface ToastAction {
  label: string;
  onClick(): void;
}

interface ToastState {
  toasts: Toast[];
  push(message: string, kind?: ToastKind, action?: ToastAction): string;
  dismiss(id: string): void;
}

const AUTO_DISMISS_MS = 4000;
// A toast with a button needs time to reach it: 4 seconds is too short for
// anyone using a pointer slowly or a keyboard, and the action is gone with it.
const ACTION_DISMISS_MS = 12000;
let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = 'info', action) => {
    const id = `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind, action }] }));
    window.setTimeout(
      () => useToastStore.getState().dismiss(id),
      action ? ACTION_DISMISS_MS : AUTO_DISMISS_MS,
    );
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience for non-React callers (plugins, commands). */
export const pushToast = (
  message: string,
  kind: ToastKind = 'info',
  action?: ToastAction,
): string => useToastStore.getState().push(message, kind, action);
