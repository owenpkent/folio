import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { getEngine } from '@/core/pdf';
import {
  rectAt,
  usePlacementStore,
  type PagePoint,
  type PlacementAnchor,
} from '@/features/placement';
import { useDocumentStore } from '@/state/documentStore';

import { useEditStore } from './store';
import { DEFAULT_FONT_SIZE_PT, type ImageEdit } from './types';

const ready = () => useDocumentStore.getState().status === 'ready';

/**
 * Drop an empty text box where the user clicked, ready to type. Anchored
 * top-left by default, so the text starts at the click.
 */
async function placeTextAt(
  pageNumber: number,
  point: PagePoint,
  anchor: PlacementAnchor = 'topLeft',
): Promise<void> {
  const { height: ph } = await getEngine().getPageDimensions(pageNumber, 1);

  const rectW = 0.34;
  // Default to ~2 lines tall; the user can resize.
  const rectH = Math.min(0.5, (DEFAULT_FONT_SIZE_PT * 1.5 * 2) / (ph || 792));

  useEditStore.getState().addText(pageNumber, rectAt(point, rectW, rectH, anchor));
  announce('Text box added. Type your text, then drag it to reposition.');
}

/** Drop an image centered on the click, preserving its aspect ratio. */
async function placeImageAt(
  pageNumber: number,
  point: PagePoint,
  anchor: PlacementAnchor = 'center',
  dataUrl: string,
  mime: ImageEdit['mime'],
  aspect: number,
): Promise<void> {
  const { width: pw, height: ph } = await getEngine().getPageDimensions(pageNumber, 1);

  const rectW = 0.28;
  const displayW = rectW * pw;
  const displayH = displayW / (aspect || 1);
  const rectH = Math.min(0.4, displayH / (ph || 792));

  useEditStore.getState().addImage(pageNumber, dataUrl, mime, rectAt(point, rectW, rectH, anchor));
  announce('Image placed. Drag it to reposition, or drag the corner to resize.');
}

/** Arm click-to-place for a new text box. */
export function beginTextPlacement(): void {
  if (!ready()) return;
  usePlacementStore.getState().begin({ label: 'text box', place: placeTextAt });
}

/** Arm click-to-place for an already-loaded image. */
export function beginImagePlacement(
  dataUrl: string,
  mime: ImageEdit['mime'],
  aspect: number,
): void {
  if (!ready()) return;
  usePlacementStore.getState().begin({
    label: 'image',
    place: (pageNumber, point, anchor) =>
      placeImageAt(pageNumber, point, anchor, dataUrl, mime, aspect),
  });
}

interface PickedImage {
  dataUrl: string;
  mime: ImageEdit['mime'];
  aspect: number;
}

/**
 * Open a file picker for a PNG/JPEG and return it as a data URL plus aspect
 * ratio. Uses a hidden file input, which works in both the desktop WebView and
 * a plain browser (mirrors the open-file fallback in core/document).
 */
function pickImageFile(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => input.remove();

    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) return resolve(null);
      const mime: ImageEdit['mime'] | null =
        file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : null;
      if (!mime) {
        pushToast('Only PNG and JPEG images are supported', 'error');
        return resolve(null);
      }
      const reader = new FileReader();
      reader.onerror = () => {
        pushToast('Could not read the image file', 'error');
        resolve(null);
      };
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const img = new Image();
        img.onload = () =>
          resolve({ dataUrl, mime, aspect: img.naturalWidth / (img.naturalHeight || 1) });
        img.onerror = () => {
          pushToast('Could not decode the image', 'error');
          resolve(null);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
}

let registered = false;

/** Register the editing (add text / add image) commands. Idempotent. */
export function registerEditCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'edit.addText',
    title: 'Add text box',
    category: 'Edit',
    when: ready,
    run: () => beginTextPlacement(),
  });

  commandRegistry.register({
    id: 'edit.addImage',
    title: 'Add image…',
    category: 'Edit',
    when: ready,
    run: async () => {
      const picked = await pickImageFile();
      if (picked) beginImagePlacement(picked.dataUrl, picked.mime, picked.aspect);
    },
  });
}
