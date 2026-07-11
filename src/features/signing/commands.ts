import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { useSigningStore } from './store';

let registered = false;

/** Register digital-signing commands. Idempotent. */
export function registerSigningCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'sign.digitallySign',
    title: 'Digitally sign…',
    category: 'Sign',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => useSigningStore.getState().setModalOpen(true),
  });
}
