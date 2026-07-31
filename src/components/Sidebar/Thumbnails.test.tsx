import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PdfCore from '@/core/pdf';

// No thumbnail is rasterised in these tests (nothing reports as near), but the
// module still resolves the engine on import.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return {
    ...actual,
    getEngine: () => ({ renderPage: async () => {} }),
  };
});

import { primePageSizeEstimate, resetPageSizes } from '@/core/pdf/pageSizes';
import { useViewerStore } from '@/state/viewerStore';

import { Thumbnails } from './Thumbnails';

describe('Thumbnails', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    // jsdom has no layout, so the follow-the-current-page effect has nothing to
    // scroll; it only needs to not throw.
    Element.prototype.scrollIntoView = vi.fn();
    useViewerStore.setState({ numPages: 3 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useViewerStore.getState().reset();
    resetPageSizes();
  });

  it('reserves each frame from the page shape before anything is rendered into it', () => {
    primePageSizeEstimate({ width: 612, height: 792 });
    render(<Thumbnails />);

    const frames = document.querySelectorAll<HTMLElement>('.folio-thumb__frame');
    expect(frames).toHaveLength(3);
    // The width comes from the stylesheet; the ratio is the only part that
    // depends on the document. Without it the frame is sized by its canvas,
    // which is 0x0 until the thumbnail renders.
    for (const frame of frames) {
      expect(frame.style.aspectRatio).toBe('612 / 792');
    }
  });

  it('leaves the ratio to the stylesheet until a size is known', () => {
    render(<Thumbnails />);

    for (const frame of document.querySelectorAll<HTMLElement>('.folio-thumb__frame')) {
      expect(frame.style.aspectRatio).toBe('');
    }
  });
});
