import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { useSigningStore } from '@/features/signing';
import { reloadEditedBytes } from '@/state/actions';
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
    when: () => ready() && useTextEditStore.getState().active,
    run: async () => {
      const bytes = useTextEditStore.getState().popUndo();
      if (bytes) await reloadEditedBytes(bytes);
    },
  });
}
