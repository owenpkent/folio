import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { getEngine } from '@/core/pdf';
import { rectAt, usePlacementStore, type PagePoint } from '@/features/placement';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { useSignatureStore } from './store';

/**
 * Drop a freshly-created signature centered on the click, at a sensible
 * default size that preserves the image aspect ratio.
 */
async function placeSignatureAt(
  pageNumber: number,
  point: PagePoint,
  dataUrl: string,
  aspect: number,
): Promise<void> {
  const { width: pw, height: ph } = await getEngine().getPageDimensions(pageNumber, 1);

  const rectW = 0.28;
  const displayW = rectW * pw;
  const displayH = displayW / (aspect || 3);
  const rectH = Math.min(0.4, displayH / (ph || 792));

  useSignatureStore.getState().add(pageNumber, dataUrl, rectAt(point, rectW, rectH, 'center'));
  announce('Signature placed. Drag it to reposition, or drag the corner to resize.');
}

/**
 * Arm click-to-place for a created signature: the next click on a page decides
 * where it lands.
 */
export function beginSignaturePlacement(dataUrl: string, aspect: number): void {
  const { info, status } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return;

  usePlacementStore.getState().begin({
    label: 'signature',
    // No anchor override to honor: a signature is centered on the placement
    // point either way, so the keyboard path lands it in the middle of the page.
    place: (pageNumber, point) => placeSignatureAt(pageNumber, point, dataUrl, aspect),
  });
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
