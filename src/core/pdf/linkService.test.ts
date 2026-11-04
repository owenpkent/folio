import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./setupWorker', () => ({ ensureWorker: () => {}, pdfWasmUrl: () => '' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({}));

import type { PDFDocumentProxy } from 'pdfjs-dist';

import { useViewerStore } from '@/state/viewerStore';

import { createLinkService } from './PdfJsEngine';

const REF = { num: 7, gen: 0 };

function fakeDoc(): PDFDocumentProxy {
  return {
    getDestination: vi.fn(async (name: string) =>
      name === 'chap2' ? [REF, { name: 'Fit' }] : null,
    ),
    getPageIndex: vi.fn(async () => 3),
  } as unknown as PDFDocumentProxy;
}

describe('createLinkService', () => {
  beforeEach(() => {
    useViewerStore.setState({ numPages: 10, currentPage: 1, pendingScrollPage: null });
  });

  it('opens a plain external link in a new window', () => {
    const a = document.createElement('a');
    createLinkService().addLinkAttributes(a, 'https://example.com/');
    expect(a.href).toBe('https://example.com/');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer nofollow');
  });

  it('opens a newWindow link in a new window', () => {
    const a = document.createElement('a');
    createLinkService().addLinkAttributes(a, 'https://example.com/', true);
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener noreferrer nofollow');
  });

  it('goToPage drives the viewer store', () => {
    createLinkService().goToPage(4);
    expect(useViewerStore.getState().currentPage).toBe(4);
    expect(useViewerStore.getState().pendingScrollPage).toBe(4);
  });

  it('goToDestination resolves a named destination', async () => {
    const doc = fakeDoc();
    await createLinkService(() => doc).goToDestination('chap2');
    expect(useViewerStore.getState().currentPage).toBe(4);
  });

  it('goToDestination resolves an explicit destination array', async () => {
    const doc = fakeDoc();
    await createLinkService(() => doc).goToDestination([REF, { name: 'XYZ' }]);
    expect(useViewerStore.getState().currentPage).toBe(4);
  });

  it('goToDestination ignores unknown destinations and a missing document', async () => {
    await createLinkService(() => fakeDoc()).goToDestination('nope');
    await createLinkService().goToDestination('chap2');
    expect(useViewerStore.getState().currentPage).toBe(1);
  });
});
