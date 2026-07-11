import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { getEngine } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { useSignatureStore } from './store';

/**
 * Place a freshly-created signature on the page the user is currently viewing,
 * centered, at a sensible default size that preserves the image aspect ratio.
 */
export async function placeSignatureOnCurrentPage(dataUrl: string, aspect: number): Promise<void> {
  const { info, status } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return;

  const { currentPage } = useViewerStore.getState();
  const { width: pw, height: ph } = await getEngine().getPageDimensions(currentPage, 1);

  const rectW = 0.28;
  const displayW = rectW * pw;
  const displayH = displayW / (aspect || 3);
  const rectH = Math.min(0.4, displayH / ph);
  const rect = { x: 0.5 - rectW / 2, y: 0.5 - rectH / 2, width: rectW, height: rectH };

  useSignatureStore.getState().add(currentPage, dataUrl, rect);
  announce('Signature placed. Drag it to reposition, or drag the corner to resize.');
}

let registered = false;

/** Register signing commands. Idempotent. */
export function registerSignatureCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'sign.addSignature',
    title: 'Add signature…',
    category: 'Sign',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => useViewerStore.getState().setSignatureModalOpen(true),
  });
}
