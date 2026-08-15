import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { usePageOpsStore } from '@/features/pageops/store';
import { useSigningStore } from '@/features/signing';
import { reloadEditedBytes } from '@/state/actions';
import {
  documentMutationBlocked,
  DOCUMENT_MUTATION_BUSY_TITLE,
  withDocumentMutation,
} from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';

import { useTextEditStore } from './store';

const ready = () => useDocumentStore.getState().status === 'ready';

let registered = false;

/** Register the in-place text editing commands (toggle + undo). Idempotent. */
export function registerTextEditCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'textedit.toggle',
    title: 'Edit text',
    category: 'Edit',
    when: ready,
    run: () => {
      useTextEditStore.getState().toggleActive();
      if (useTextEditStore.getState().active) {
        if (useSigningStore.getState().detected.length > 0) {
          pushToast(
            'This document is digitally signed. Editing text will invalidate its signatures.',
            'info',
          );
        }
      } else {
        // Leaving the tool clears any editor left open mid-edit.
        useTextEditStore.getState().endSession();
      }
    },
  });

  commandRegistry.register({
    id: 'textedit.undo',
    title: 'Undo text edit',
    category: 'Edit',
    keybinding: 'Mod+z',
    // The lock: some OTHER feature is mid-flight rewriting the document (see
    // documentMutationStore.ts); undoing on top of that would race it.
    when: () =>
      ready() &&
      useTextEditStore.getState().active &&
      !documentMutationBlocked('textedit', 'content'),
    run: async () => {
      await withDocumentMutation(
        { owner: 'textedit', scope: 'content' },
        async () => {
          // Popped inside the lock: popUndo mutates the stack, so doing it
          // before an acquire that might be refused would discard a snapshot
          // that never got used.
          const bytes = useTextEditStore.getState().popUndo();
          if (!bytes) return;
          // Before the reload for the same reason TextEditLayer clears it
          // there: reloadEditedBytes can reject after pdf.js has taken the
          // bytes, and page ops' snapshots describe bytes from before this
          // reload either way.
          usePageOpsStore.getState().clearUndo();
          await reloadEditedBytes(bytes);
        },
        () => pushToast(DOCUMENT_MUTATION_BUSY_TITLE, 'info'),
      );
    },
  });
}
