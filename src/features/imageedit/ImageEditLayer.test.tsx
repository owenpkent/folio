import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Common from '@/components/common';
import type * as PdfCore from '@/core/pdf';
import { useDocumentMutationStore } from '@/state/documentMutationStore';

// Mock function references shared between the vi.mock factories below and the
// test bodies. vi.hoisted is required (rather than a plain module-scope
// const) because vi.mock calls are themselves hoisted above the rest of the
// module; mirrors features/export/saveDocument.test.ts.
const { getLocatedImages, announce, pushToast } = vi.hoisted(() => ({
  getLocatedImages: vi.fn(),
  announce: vi.fn(),
  pushToast: vi.fn(),
}));

// ImageEditLayer needs a viewport (once an image is selected, it renders
// selection chrome positioned via pdfRectToCssRect, which calls into it) and
// saveDocument (getLocatedImages' own dependency, stubbed out separately
// below) from the engine; an identity transform is enough since no test here
// asserts on the resulting pixel rect, only on store state.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return {
    ...actual,
    getEngine: () => ({
      getPageViewport: async () => ({
        convertToPdfPoint: (x: number, y: number) => [x, y],
        convertToViewportPoint: (x: number, y: number) => [x, y],
      }),
      saveDocument: async () => new Uint8Array(),
    }),
  };
});

// Bypasses locatePageImages' real content-stream parsing (and the need for a
// loadable PDF fixture) so each test can hand ImageEditLayer a canned page.
vi.mock('./locateCache', () => ({
  getLocatedImages,
  clearLocatedImagesCache: vi.fn(),
}));

vi.mock('@/a11y/announcer', () => ({ announce }));

// Only pushToast is replaced: the layer renders Icon from this same barrel, so
// the rest of it has to stay real.
vi.mock('@/components/common', async (orig) => ({
  ...((await orig()) as typeof Common),
  pushToast,
}));

import { ImageEditLayer } from './ImageEditLayer';
import { useImageEditStore } from './store';
import type { LocatedImage } from './types';

const baseImage: Omit<LocatedImage, 'name' | 'editable'> = {
  streamIndex: 0,
  start: 0,
  end: 0,
  ctm: [10, 0, 0, 10, 0, 0],
  rect: { x: 0, y: 0, width: 10, height: 10 },
  flipX: false,
  flipY: false,
  naturalWidth: 10,
  naturalHeight: 10,
  transformable: true,
};

describe('ImageEditLayer keyboard activation', () => {
  afterEach(() => {
    cleanup();
    useImageEditStore.getState().reset();
    getLocatedImages.mockReset();
    announce.mockReset();
  });

  it('selects the first editable image, skipping a non-editable one ahead of it', async () => {
    const blocked: LocatedImage = { ...baseImage, name: 'Im1', editable: false };
    const editable: LocatedImage = { ...baseImage, name: 'Im2', editable: true };
    getLocatedImages.mockResolvedValue([blocked, editable]);
    useImageEditStore.setState({ active: true });

    render(<ImageEditLayer pageNumber={1} />);

    // jsdom never fires pointer events on its own, so Tab+Enter is the only
    // way to reach the catcher the way a keyboard user actually would (see
    // features/annotations/NotesLayer.test.tsx for the same pattern): no
    // pointerdown/pointerup, just focus and a key press -- exactly the
    // detail === 0 activation this fallback keys off of.
    const catcher = screen.getByRole('button', { name: /select the first editable image/i });
    catcher.focus();
    await userEvent.setup().keyboard('{Enter}');

    expect(useImageEditStore.getState().selected).toMatchObject({
      pageIndex: 0,
      streamIndex: editable.streamIndex,
      name: editable.name,
    });
    expect(announce).not.toHaveBeenCalled();
  });

  it('announces instead of selecting when no image on the page is editable', async () => {
    const blocked: LocatedImage = { ...baseImage, name: 'Im1', editable: false };
    getLocatedImages.mockResolvedValue([blocked]);
    useImageEditStore.setState({ active: true });

    render(<ImageEditLayer pageNumber={1} />);

    const catcher = screen.getByRole('button', { name: /select the first editable image/i });
    catcher.focus();
    await userEvent.setup().keyboard('{Enter}');

    expect(useImageEditStore.getState().selected).toBeNull();
    expect(announce).toHaveBeenCalledWith(expect.stringMatching(/no editable image/i), true);
  });
});

describe('ImageEditLayer document-mutation lock', () => {
  afterEach(() => {
    cleanup();
    useImageEditStore.getState().reset();
    useDocumentMutationStore.setState({ active: [] });
    getLocatedImages.mockReset();
    pushToast.mockReset();
    announce.mockReset();
  });

  it('releases the cross-feature lock even when a commit fails', async () => {
    const editable: LocatedImage = { ...baseImage, name: 'Im1', editable: true };
    getLocatedImages.mockResolvedValue([editable]);
    useImageEditStore.setState({ active: true });

    render(<ImageEditLayer pageNumber={1} />);

    const catcher = screen.getByRole('button', { name: /select the first editable image/i });
    catcher.focus();
    await userEvent.setup().keyboard('{Enter}');

    const deleteButton = await screen.findByRole('button', { name: 'Delete image' });
    // getEngine().saveDocument() (mocked above) resolves to an empty
    // Uint8Array, which is not a loadable PDF, so commitImageEdit's own
    // PDFDocument.load rejects this commit on its own -- exactly the kind of
    // failure the lock's release has to survive without being asked to.
    await userEvent.setup().click(deleteButton);

    // The error toast first, and asserted on rather than merely awaited: it is
    // the only evidence the commit actually ran and actually failed. Checking
    // the released lock alone proved nothing, because an idle lock is equally
    // what a SUCCESSFUL commit and a commit that never started leave behind --
    // so the test would have gone on passing if the mock ever became loadable
    // or the Delete button stopped appearing.
    await waitFor(() => {
      expect(pushToast).toHaveBeenCalledWith(expect.any(String), 'error');
    });
    expect(useDocumentMutationStore.getState().active).toEqual([]);
  });

  it('refuses a keyboard delete while another feature holds the lock, and says so', async () => {
    const editable: LocatedImage = { ...baseImage, name: 'Im1', editable: true };
    getLocatedImages.mockResolvedValue([editable]);
    useImageEditStore.setState({ active: true });

    render(<ImageEditLayer pageNumber={1} />);

    const catcher = screen.getByRole('button', { name: /select the first editable image/i });
    catcher.focus();
    await userEvent.setup().keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Delete image' });

    // A page op takes the lock after the image is already selected and focused.
    act(() => {
      useDocumentMutationStore.getState().acquire({ owner: 'pageops', scope: 'pages' });
    });

    announce.mockReset();
    await userEvent.setup().keyboard('{Delete}');

    // useNudgeKeys used to announce "Image deleted" unconditionally, while the
    // layer's own busy check quietly refused the delete: the screen-reader user
    // was told the image was gone while looking at it still there.
    const said = announce.mock.calls.map((call) => String(call[0])).join(' | ');
    expect(said).not.toMatch(/deleted/i);
    expect(useImageEditStore.getState().selected).not.toBeNull();
  });
});
