import { create } from 'zustand';

/**
 * A yes/no question the app has to put to the user before going ahead with
 * something they already asked for.
 *
 * Deliberately not `window.confirm`: that blocks the whole renderer (so a
 * background OCR pass or a render would stall behind it), it cannot be styled
 * or themed, it is unreachable in the VS Code webview, and it names the page's
 * origin in a way that reads like a browser warning rather than part of Folio.
 */
export interface ConfirmOptions {
  /** The dialog's accessible name and heading. */
  title: string;
  /** The body. One or two sentences: what is about to happen, and why it may not be what they want. */
  message: string;
  /** The go-ahead button. Name the action ("Save anyway"), never "OK". */
  confirmLabel: string;
  /** The way out. Name that action too ("Wait for OCR"), never "Cancel" alone where a better word exists. */
  cancelLabel: string;
}

interface PendingConfirm extends ConfirmOptions {
  /** Distinguishes one question from the next, so a stale answer cannot resolve a newer one. */
  id: number;
  resolve(confirmed: boolean): void;
}

interface ConfirmState {
  pending: PendingConfirm | null;
  nextId: number;
  ask(options: ConfirmOptions): Promise<boolean>;
  /** Answer the pending question. A stale id is ignored. */
  answer(id: number, confirmed: boolean): void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  nextId: 1,

  ask: (options) => {
    // One at a time. Every caller today reaches this from an entry point that
    // is already guarded against re-entry (the document mutation lock, print's
    // own `inFlight`), so a second question while one is open would mean a bug
    // upstream rather than a user with two dialogs to answer. Refusing is the
    // safe direction: the caller treats it as "not confirmed" and does nothing.
    if (get().pending) return Promise.resolve(false);

    return new Promise<boolean>((resolve) => {
      const id = get().nextId;
      set({ pending: { ...options, id, resolve }, nextId: id + 1 });
    });
  },

  answer: (id, confirmed) => {
    const { pending } = get();
    if (!pending || pending.id !== id) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));

/**
 * Ask the user a yes/no question and wait for the answer. Resolves false if
 * they decline, dismiss with `Escape`, or a question is somehow already open.
 *
 * This is a human-scale wait, so callers must ask BEFORE taking the document
 * mutation lock -- holding it across a dialog freezes every other feature for
 * as long as the user takes to read (see state/documentMutationStore.ts, and
 * the same rule applied to native file dialogs in features/export).
 */
export function askConfirmation(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().ask(options);
}
