import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';

// Mock function references shared between the vi.mock factories below and the
// test bodies. vi.hoisted is required (rather than a plain module-scope
// const) because vi.mock calls are themselves hoisted above the rest of the
// module; mirrors features/export/saveDocument.test.ts.
const { getLocatedImages, announce } = vi.hoisted(() => ({
  getLocatedImages: vi.fn(),
  announce: vi.fn(),
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
