import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OpenDocument from '@/core/document/openDocument';
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

// Combine prompts for files as soon as it opens. jsdom has no picker, so the
// real one appends a hidden <input type="file"> to the body and waits on a
// change event that never comes: a promise that never settles, a node that
// outlives testing-library's cleanup, and a store write landing outside act()
// whenever it did.
vi.mock('@/core/document/openDocument', async (orig) => {
  const actual = (await orig()) as typeof OpenDocument;
  return {
    ...actual,
    pickAndReadDocuments: vi.fn(async () => ({ sources: [], failed: [] })),
  };
});

import { primePageSizeEstimate, resetPageSizes } from '@/core/pdf/pageSizes';
import { registerCombineCommands, useCombineStore } from '@/features/combine';
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
    // The panel dispatches file.combine rather than calling the feature, so
    // the command has to be registered for the button to do anything.
    registerCombineCommands();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useViewerStore.getState().reset();
    useCombineStore.getState().close();
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

  it('offers Combine PDFs from the pages panel', async () => {
    const { getByRole } = render(<Thumbnails />);

    await userEvent.click(getByRole('button', { name: /combine pdfs/i }));

    expect(useCombineStore.getState().modalOpen).toBe(true);
  });

  it('still offers Combine PDFs with no document open', () => {
    // The combine modal takes its inputs from a picker, so it is the one thing
    // on this tab worth reaching from an empty viewer.
    useViewerStore.setState({ numPages: 0 });
    const { getByRole, getByText } = render(<Thumbnails />);

    expect(getByText('No document open.')).toBeTruthy();
    expect(getByRole('button', { name: /combine pdfs/i })).toBeTruthy();
  });
});
