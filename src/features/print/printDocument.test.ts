import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { PrintProgressModal } from './PrintProgressModal';
import { printDocument, registerPrintCommands } from './printDocument';
import { usePrintStore } from './store';

const exportDocument = vi.hoisted(() => vi.fn(async () => new Uint8Array([1, 2, 3])));
const destroy = vi.hoisted(() => vi.fn(async () => undefined));

/** Everything the fake PDF.js document does, steerable from a test body. */
const pdf = vi.hoisted(() => ({
  numPages: 3,
  baseWidth: 612,
  baseHeight: 792,
  /** The scale each page was actually rasterized at, in page order. */
  renderScales: [] as number[],
  /** Pages whose render rejects, standing in for a mid-document failure. */
  failRenderOn: new Set<number>(),
  /** Pages whose render never settles unless something cancels it. */
  stallRenderOn: new Set<number>(),
  cancelledRenders: 0,
  /** Called from render(), for tests that need to act while a page is in flight. */
  onRender: null as ((pageNumber: number) => void) | null,
}));

vi.mock('@/features/export', () => ({ exportDocument }));
vi.mock('@/core/pdf/setupWorker', () => ({
  ensureWorker: vi.fn(),
  pdfWasmUrl: () => 'https://folio.test/pdfjs-wasm/',
}));
vi.mock('@/a11y/announcer', () => ({ announce: vi.fn() }));

// The legacy build, which is the one printDocument imports and the one
// ensureWorker() configures. Mocking bare 'pdfjs-dist' instead is what let this
// suite pass green while every real print died on an unconfigured worker: the
// mock stood in for a module the app should never have been importing.
//
// Shaped like PDF.js 6: getDocument() hands back a loading task that owns
// destroy() (PDFDocumentProxy.destroy() is gone), and render() takes the canvas
// rather than a 2D context.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn((params: { wasmUrl?: string }) => ({
    destroy,
    promise: Promise.resolve({
      get numPages() {
        return pdf.numPages;
      },
      getPage: vi.fn(async (pageNumber: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: pdf.baseWidth * scale,
          height: pdf.baseHeight * scale,
        }),
        render: ({
          canvas,
          viewport,
        }: {
          canvas: HTMLCanvasElement;
          viewport: { width: number };
        }) => {
          // A render that was handed no canvas draws nothing, and every
          // assertion downstream is about a viewport, so it would pass anyway.
          if (!(canvas instanceof HTMLCanvasElement)) {
            throw new Error('render() was called without a canvas');
          }
          if (!params.wasmUrl) {
            throw new Error('getDocument() was called without wasmUrl');
          }
          pdf.renderScales.push(viewport.width / pdf.baseWidth);
          let rejectTask: (reason: unknown) => void = () => undefined;
          const promise = new Promise<void>((resolve, reject) => {
            rejectTask = reject;
            if (pdf.failRenderOn.has(pageNumber)) {
              reject(new Error(`render failed on page ${pageNumber}`));
            } else if (!pdf.stallRenderOn.has(pageNumber)) {
              resolve();
            }
          });
          pdf.onRender?.(pageNumber);
          return {
            promise,
            cancel: () => {
              pdf.cancelledRenders += 1;
              rejectTask(new Error('Rendering cancelled'));
            },
          };
        },
      })),
    }),
  })),
}));

let createdUrls: string[] = [];
let revokedUrls: string[] = [];
/** Blob URLs whose <img> should report no decoded bitmap, i.e. a failed page. */
let brokenUrls = new Set<string>();
let printSpy: ReturnType<typeof vi.fn>;
let naturalWidth: PropertyDescriptor | undefined;
let naturalHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  createdUrls = [];
  revokedUrls = [];
  brokenUrls = new Set();
  pdf.numPages = 3;
  pdf.baseWidth = 612;
  pdf.baseHeight = 792;
  pdf.renderScales = [];
  pdf.failRenderOn = new Set();
  pdf.stallRenderOn = new Set();
  pdf.cancelledRenders = 0;
  pdf.onRender = null;
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

  // jsdom never decodes, and never loads a blob: URL either. naturalWidth is
  // what the pipeline reads to decide a page actually made it, so it is faked
  // per URL: anything in brokenUrls looks like an image that never loaded.
  HTMLImageElement.prototype.decode = vi.fn(async () => undefined);
  naturalWidth = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');
  naturalHeight = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalHeight');
  const size: PropertyDescriptor = {
    configurable: true,
    get(this: HTMLImageElement) {
      return brokenUrls.has(this.getAttribute('src') ?? '') ? 0 : 120;
    },
  };
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', size);
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', size);

  printSpy = vi.fn();
  vi.stubGlobal('print', printSpy);
});

afterEach(() => {
  // Let any deferred teardown run, so its timer does not outlive the test.
  window.dispatchEvent(new Event('afterprint'));
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (naturalWidth) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', naturalWidth);
  else Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalWidth');
  if (naturalHeight)
    Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', naturalHeight);
  else Reflect.deleteProperty(HTMLImageElement.prototype, 'naturalHeight');
  document.getElementById('folio-print-root')?.remove();
  document.body.classList.remove('folio-printing');
});

/** Total bytes of decoded RGBA the run asked the browser to hold at once. */
function residentBytes(): number {
  return pdf.renderScales.reduce(
    (total, scale) =>
      total + Math.floor(pdf.baseWidth * scale) * Math.floor(pdf.baseHeight * scale) * 4,
    0,
  );
}

describe('printDocument', () => {
  it('bakes edits in before rasterizing, so overlays reach the paper', async () => {
    await printDocument();

    // The whole point: print goes through the save pipeline, not the on-screen
    // canvas, because edits are DOM overlays that are not in that canvas.
    expect(exportDocument).toHaveBeenCalledTimes(1);
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('hands the print dialog one image per page, with the stylesheet armed', async () => {
    let rootAtPrintTime: HTMLElement | null = null;
    let armedAtPrintTime = false;
    printSpy.mockImplementation(() => {
      rootAtPrintTime = document.getElementById('folio-print-root');
      armedAtPrintTime = document.body.classList.contains('folio-printing');
    });

    await printDocument();

    expect(rootAtPrintTime).not.toBeNull();
    expect(rootAtPrintTime!.querySelectorAll('.folio-print-page img')).toHaveLength(3);
    // The print stylesheet hides the whole UI, so it must only be armed for a
    // print that came from here.
    expect(armedAtPrintTime).toBe(true);
  });

  it('keeps the images alive until the print job has let go of them', async () => {
    await printDocument();

    // print() has returned but afterprint has not fired. On WebKit that means
    // the preview is still being generated, so revoking now prints blank pages.
    expect(document.getElementById('folio-print-root')).not.toBeNull();
    expect(revokedUrls).toEqual([]);

    window.dispatchEvent(new Event('afterprint'));

    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });

  it('leaves no print DOM, blob URLs, or armed stylesheet behind', async () => {
    await printDocument();
    window.dispatchEvent(new Event('afterprint'));

    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(document.body.classList.contains('folio-printing')).toBe(false);
    expect(createdUrls).toHaveLength(3);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('takes the progress modal off screen before opening the dialog', async () => {
    render(createElement(PrintProgressModal));
    // A real macrotask so React's scheduler gets a turn and the modal is
    // genuinely mounted before rasterizing starts.
    exportDocument.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return new Uint8Array([1, 2, 3]);
    });

    let dialogMidRun = 0;
    let dialogAtPrintTime = 0;
    pdf.onRender = () => {
      dialogMidRun = document.querySelectorAll('[role="dialog"]').length;
    };
    printSpy.mockImplementation(() => {
      dialogAtPrintTime = document.querySelectorAll('[role="dialog"]').length;
    });

    await printDocument();

    // finish() alone only queues the unmount; print() is synchronous, so the
    // dialog and its focus trap would still be on the page it captures.
    expect(dialogMidRun).toBe(1);
    expect(dialogAtPrintTime).toBe(0);
  });

  it('does nothing without an open document', async () => {
    useDocumentStore.setState({ status: 'empty' });

    await printDocument();

    expect(exportDocument).not.toHaveBeenCalled();
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('surfaces a failure instead of printing a half-rendered document', async () => {
    // Page 1 rasterizes, page 2 blows up: the half-rendered case the name
    // promises. Nothing may reach the printer, and page 1 must not be stranded.
    pdf.failRenderOn = new Set([2]);

    await printDocument();

    expect(createdUrls).toHaveLength(1);
    expect(printSpy).not.toHaveBeenCalled();
    expect(usePrintStore.getState().status).toBe('error');
    expect(usePrintStore.getState().error).toContain('page 2');
    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(document.body.classList.contains('folio-printing')).toBe(false);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('still prints when decode() rejects but the image loaded anyway', async () => {
    // WebKit rejects decode() for reasons that have nothing to do with the
    // image being usable, so a rejection on its own must not fail the run.
    HTMLImageElement.prototype.decode = vi.fn(async () => {
      throw new Error('decode unsupported');
    });

    await printDocument();

    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(usePrintStore.getState().status).toBe('idle');
  });

  it('surfaces a failure when a page produced no bitmap at all', async () => {
    // The second page's image never loads. Printing the other two silently
    // hands the user a document with a blank sheet in it and no reason given.
    brokenUrls = new Set(['blob:print-2']);

    await printDocument();

    expect(printSpy).not.toHaveBeenCalled();
    expect(usePrintStore.getState().status).toBe('error');
    expect(usePrintStore.getState().error).toContain('1 of 3');
    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(document.body.classList.contains('folio-printing')).toBe(false);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });

  it('stops when cancelled mid-run and prints nothing', async () => {
    pdf.numPages = 50;
    // Cancel as soon as the store reports the first page.
    const unsubscribe = usePrintStore.subscribe((s) => {
      if (s.progress.current === 1 && !s.cancelRequested) usePrintStore.getState().requestCancel();
    });

    await printDocument();
    unsubscribe();

    expect(printSpy).not.toHaveBeenCalled();
    expect(usePrintStore.getState().status).toBe('idle');
    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });

  it('cancels the page that is mid-render, not just the next one', async () => {
    pdf.numPages = 20;
    pdf.stallRenderOn = new Set([1]);
    // The task has to exist before it can be cancelled, so ask on the tick
    // after render() returns.
    pdf.onRender = () => {
      queueMicrotask(() => usePrintStore.getState().requestCancel());
    };

    await printDocument();

    expect(pdf.cancelledRenders).toBe(1);
    expect(printSpy).not.toHaveBeenCalled();
    // A cancel is a user action, not a failure: no error state, no toast.
    expect(usePrintStore.getState().status).toBe('idle');
    expect(document.getElementById('folio-print-root')).toBeNull();
  });

  it('stops when cancelled after the last page, before the dialog opens', async () => {
    const unsubscribe = usePrintStore.subscribe((s) => {
      if (s.progress.current === pdf.numPages && !s.cancelRequested) {
        queueMicrotask(() => usePrintStore.getState().requestCancel());
      }
    });

    await printDocument();
    unsubscribe();

    // Every page rasterized, so the in-loop check cannot be what caught this.
    expect(createdUrls).toHaveLength(3);
    expect(printSpy).not.toHaveBeenCalled();
    expect(document.getElementById('folio-print-root')).toBeNull();
    expect(document.body.classList.contains('folio-printing')).toBe(false);
    expect(revokedUrls.sort()).toEqual(createdUrls.sort());
  });

  it('ignores a second run started while one is already in flight', async () => {
    let rootsAtPrintTime = 0;
    printSpy.mockImplementation(() => {
      rootsAtPrintTime = document.querySelectorAll('#folio-print-root').length;
    });

    // Impatient double-click on File > Print, or a plugin calling this while
    // the user already started a run.
    await Promise.all([printDocument(), printDocument(), printDocument()]);

    expect(exportDocument).toHaveBeenCalledTimes(1);
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(rootsAtPrintTime).toBe(1);
    expect(createdUrls).toHaveLength(3);
  });

  it('scales a long document down so its page bitmaps fit the budget', async () => {
    pdf.numPages = 300;

    await printDocument();

    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(pdf.renderScales).toHaveLength(300);
    // Every page rasterized smaller than the 2x a short document gets, and the
    // whole run fits the 768 MiB budget rather than the ~2.2 GiB 2x would cost.
    expect(pdf.renderScales[0]).toBeLessThan(2);
    expect(pdf.renderScales[0]).toBeGreaterThanOrEqual(0.75);
    expect(residentBytes()).toBeLessThanOrEqual(768 * 1024 * 1024);
  });

  it('refuses a document too long to rasterize instead of running out of memory', async () => {
    pdf.numPages = 5000;

    await printDocument();

    // Nothing was allocated: the refusal happens before the first page.
    expect(pdf.renderScales).toEqual([]);
    expect(createdUrls).toEqual([]);
    expect(printSpy).not.toHaveBeenCalled();
    expect(usePrintStore.getState().status).toBe('error');
    expect(usePrintStore.getState().error).toContain('5000 pages');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('clamps an oversized page to the canvas ceiling', async () => {
    // A0, 2384 x 3370 user units: 32.1M pixels at 2x, past what a browser will
    // back, so it comes out blank or with a null 2D context instead.
    pdf.numPages = 1;
    pdf.baseWidth = 2384;
    pdf.baseHeight = 3370;

    await printDocument();

    expect(printSpy).toHaveBeenCalledTimes(1);
    const scale = pdf.renderScales[0];
    expect(scale).toBeLessThan(2);
    expect(Math.floor(pdf.baseWidth * scale)).toBeLessThanOrEqual(4096);
    expect(Math.floor(pdf.baseHeight * scale)).toBeLessThanOrEqual(4096);
    expect(
      Math.floor(pdf.baseWidth * scale) * Math.floor(pdf.baseHeight * scale),
    ).toBeLessThanOrEqual(16_777_216);
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
