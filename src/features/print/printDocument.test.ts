import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { printDocument, registerPrintCommands } from './printDocument';
import { usePrintStore } from './store';

const exportDocument = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2, 3])));
const destroy = vi.hoisted(() => vi.fn(async () => undefined));
const numPages = vi.hoisted(() => ({ value: 3 }));

vi.mock('@/features/export', () => ({ exportDocument }));
vi.mock('@/core/pdf/setupWorker', () => ({ ensureWorker: vi.fn() }));
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      get numPages() {
        return numPages.value;
      },
      getPage: vi.fn(async () => ({
        getViewport: () => ({ width: 612, height: 792 }),
        render: () => ({ promise: Promise.resolve() }),
      })),
      destroy,
    }),
  })),
}));

let createdUrls: string[] = [];
let revokedUrls: string[] = [];
let printSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  numPages.value = 3;
  exportDocument.mockClear();
  destroy.mockClear();
  usePrintStore.getState().finish();
  useDocumentStore.setState({ status: 'ready' });

  // jsdom has no 2D context and no toBlob; both are stubbed rather than pulling
  // in node-canvas just to prove the print pipeline's plumbing.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    {} as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
  ) {
    callback(new Blob(['x'], { type: 'image/png' }));
  } as HTMLCanvasElement['toBlob']);

  let counter = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:print-${(counter += 1)}`;
    createdUrls.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revokedUrls.push(url);
  });

  // jsdom never decodes, and never loads a blob: URL either.
  HTMLImageElement.prototype.decode = vi.fn(async () => undefined);

  printSpy = vi.fn();
  vi.stubGlobal('print', printSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.getElementById('folio-print-root')?.remove();
});

describe('printDocument', () => {
  it('bakes edits in before rasterizing, so overlays reach the paper', async () => {
    await printDocument();

    // The whole point: print goes through the save pipeline, not the on-screen
    // canvas, because edits are DOM overlays that are not in that canvas.
    expect(exportDocument).toHaveBeenCalledTimes(1);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('hands the print dialog one image per page', async () => {
    let rootAtPrintTime: HTMLElement | null = null;
    printSpy.mockImplementation(() => {
      rootAtPrintTime = document.getElementById('folio-print-root');
    });

    await printDocument();

    expect(rootAtPrintTime).not.toBeNull();
    expect(rootAtPrintTime!.querySelectorAll('.folio-print-page img')).toHaveLength(3);
  });

  it('leaves no print DOM or blob URLs behind', async () => {
    await printDocument();

    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(createdUrls).toHaveLength(3);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('does nothing without an open document', async () => {
    useDocumentStore.setState({ status: 'empty' });

    await printDocument();

    expect(exportDocument).not.toHaveBeenCalled();
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('surfaces a failure instead of printing a half-rendered document', async () => {
    exportDocument.mockRejectedValueOnce(new Error('bake exploded'));

    await printDocument();

    expect(printSpy).not.toHaveBeenCalled();
    expect(usePrintStore.getState().status).toBe('error');
    expect(document.getElementById('folio-print-root')).toBeNull();
  });

  it('stops when cancelled mid-run and prints nothing', async () => {
    numPages.value = 50;
    // Cancel as soon as the store reports the first page.
    const unsubscribe = usePrintStore.subscribe((s) => {
      if (s.progress.current === 1 && !s.cancelRequested) usePrintStore.getState().requestCancel();
    });

    await printDocument();
    unsubscribe();

    expect(printSpy).not.toHaveBeenCalled();
    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });
});

describe('registerPrintCommands', () => {
  it('binds Print to Mod+P behind an open-document guard', () => {
    registerPrintCommands();

    const command = commandRegistry.get('file.print');
    expect(command).toBeDefined();
    expect(command!.keybinding).toBe('Mod+P');

    useDocumentStore.setState({ status: 'ready' });
    expect(command!.when?.()).toBe(true);
    useDocumentStore.setState({ status: 'empty' });
    expect(command!.when?.()).toBe(false);
  });
});
