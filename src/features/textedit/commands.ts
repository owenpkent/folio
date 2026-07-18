import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { useTextEditStore } from './store';

const ready = () => useDocumentStore.getState().status === 'ready';

let registered = false;

/** Register the in-place text editing toggle command. Idempotent. */
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
      // Leaving the tool clears any editor left open mid-edit.
      if (!useTextEditStore.getState().active) {
        useTextEditStore.getState().endSession();
      }
    },
  });
}
