import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
}

interface ToastState {
  toasts: Toast[];
  push(message: string, kind?: ToastKind): string;
  dismiss(id: string): void;
}

const AUTO_DISMISS_MS = 4000;
let counter = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = 'info') => {
    const id = `toast-${++counter}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    window.setTimeout(() => useToastStore.getState().dismiss(id), AUTO_DISMISS_MS);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience for non-React callers (plugins, commands). */
export const pushToast = (message: string, kind: ToastKind = 'info'): string =>
  useToastStore.getState().push(message, kind);
