import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./setupWorker', () => ({ ensureWorker: () => {}, pdfWasmUrl: () => '' }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }));

import { openUrl } from '@tauri-apps/plugin-opener';

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

/** Run `fn` as the desktop build sees itself: with Tauri's IPC marker on window. */
function onDesktop(fn: () => void): void {
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {};
  try {
    fn();
  } finally {
    delete w.__TAURI_INTERNALS__;
  }
}

/** Click `a` and report whether the click was taken over. */
function click(a: HTMLAnchorElement): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  a.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('createLinkService', () => {
  beforeEach(() => {
    useViewerStore.setState({ numPages: 10, currentPage: 1, pendingScrollPage: null });
    vi.mocked(openUrl).mockClear();
  });

  it('on the desktop, hands an external link to the OS instead of the webview', async () => {
    const a = document.createElement('a');
    onDesktop(() => {
      createLinkService().addLinkAttributes(a, 'https://example.com/');
      expect(click(a)).toBe(true);
    });
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.com/'));
  });

  it('on the desktop, leaves a scheme the OS scope does not cover to the webview', async () => {
    const a = document.createElement('a');
    onDesktop(() => {
      createLinkService().addLinkAttributes(a, 'ftp://example.com/file');
      expect(click(a)).toBe(false);
    });
    await Promise.resolve();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('in the browser, does not touch the opener', async () => {
    const a = document.createElement('a');
    createLinkService().addLinkAttributes(a, 'https://example.com/');
    expect(click(a)).toBe(false);
    await Promise.resolve();
    expect(openUrl).not.toHaveBeenCalled();
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
