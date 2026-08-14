import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { pickAndReadDocuments } from '@/core/document/openDocument';
import { loadSource } from '@/state/actions';

import { combinePdfs } from './combineDocuments';
import { useCombineStore } from './store';

/** Prompt for one or more PDFs and add them to the pending combine list. */
export async function addFilesViaPicker(): Promise<void> {
  const sources = await pickAndReadDocuments();
  if (sources.length === 0) return;
  useCombineStore
    .getState()
    .addFiles(sources.map((source) => ({ name: source.name ?? 'Untitled.pdf', bytes: source.data })));
}

/** Open the combine modal and immediately prompt for the first batch of files. */
export async function openCombineModal(): Promise<void> {
  useCombineStore.getState().open();
  await addFilesViaPicker();
}

/**
 * Merge the pending files and load the result into the viewer, as a new,
 * pathless document -- Save then prompts for a location rather than writing
 * over any one of the inputs.
 */
export async function runCombine(): Promise<void> {
  const store = useCombineStore.getState();
  if (store.busy) return;
  if (store.files.length < 2) {
    store.setError('Add at least two PDFs to combine');
    return;
  }

  store.setBusy(true);
  store.setError(null);
  try {
    const bytes = await combinePdfs(store.files.map((f) => ({ name: f.name, bytes: f.bytes })));
    await loadSource({ kind: 'bytes', data: bytes, name: 'combined.pdf' });
    useCombineStore.getState().close();
    pushToast('Combined', 'success');
    announce(`Combined ${store.files.length} documents`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not combine these PDFs';
    useCombineStore.getState().setError(message);
    announce(`Could not combine: ${message}`, true);
  } finally {
    useCombineStore.getState().setBusy(false);
  }
}

let registered = false;

/** Register the combine command. Idempotent. */
export function registerCombineCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'file.combine',
    title: 'Combine PDFs…',
    category: 'File',
    run: () => openCombineModal(),
  });
}
