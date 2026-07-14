import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common';
import { getEngine } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { useEditStore } from './store';
import { DEFAULT_FONT_SIZE_PT, type ImageEdit } from './types';

const ready = () => useDocumentStore.getState().status === 'ready';

/** Add an empty text box centered on the page the user is viewing, ready to type. */
export async function placeTextOnCurrentPage(): Promise<void> {
  if (!ready()) return;
  const { currentPage } = useViewerStore.getState();
  const { height: ph } = await getEngine().getPageDimensions(currentPage, 1);

  const rectW = 0.34;
  // Default to ~2 lines tall; the user can resize.
  const rectH = Math.min(0.5, (DEFAULT_FONT_SIZE_PT * 1.5 * 2) / (ph || 792));
  const rect = { x: 0.5 - rectW / 2, y: 0.5 - rectH / 2, width: rectW, height: rectH };

  useEditStore.getState().addText(currentPage, rect);
  announce('Text box added. Type your text, then drag the grip to reposition.');
}

/** Place an image on the current page, preserving its aspect ratio. */
export async function placeImageOnCurrentPage(
  dataUrl: string,
  mime: ImageEdit['mime'],
  aspect: number,
): Promise<void> {
  if (!ready()) return;
  const { currentPage } = useViewerStore.getState();
  const { width: pw, height: ph } = await getEngine().getPageDimensions(currentPage, 1);

  const rectW = 0.28;
  const displayW = rectW * pw;
  const displayH = displayW / (aspect || 1);
  const rectH = Math.min(0.4, displayH / (ph || 792));
  const rect = { x: 0.5 - rectW / 2, y: 0.5 - rectH / 2, width: rectW, height: rectH };

  useEditStore.getState().addImage(currentPage, dataUrl, mime, rect);
  announce('Image placed. Drag it to reposition, or drag the corner to resize.');
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
        img.onload = () => resolve({ dataUrl, mime, aspect: img.naturalWidth / (img.naturalHeight || 1) });
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
    run: () => placeTextOnCurrentPage(),
  });

  commandRegistry.register({
    id: 'edit.addImage',
    title: 'Add image…',
    category: 'Edit',
    when: ready,
    run: async () => {
      const picked = await pickImageFile();
      if (picked) await placeImageOnCurrentPage(picked.dataUrl, picked.mime, picked.aspect);
    },
  });
}
