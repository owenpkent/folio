import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { useSigningStore } from '@/features/signing';
import { useDocumentStore } from '@/state/documentStore';

import { useImageEditStore } from './store';

const ready = () => useDocumentStore.getState().status === 'ready';

let registered = false;

/** Register the "Edit images" toggle command. Idempotent. */
export function registerImageEditCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'imageedit.toggle',
    title: 'Edit images',
    category: 'Edit',
    when: ready,
    run: () => {
      useImageEditStore.getState().toggleActive();
      if (useImageEditStore.getState().active) {
        if (useSigningStore.getState().detected.length > 0) {
          pushToast(
            'This document is digitally signed. Editing images will invalidate its signatures.',
            'info',
          );
        }
      } else {
        // Leaving the tool clears any selection left over.
        useImageEditStore.getState().select(null);
      }
    },
  });
}
