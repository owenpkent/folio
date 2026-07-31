import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pins the PDF.js 6 API shapes {@link PdfJsEngine} has to hand PDF.js, all of
 * which changed silently rather than loudly in the v4 -> v6 jump: a render is
 * given the canvas, the annotation layer is given its collaborators on the
 * constructor, and a document is torn down through its loading task. PDF.js is
 * faked here (it is the thing under contract, not under test) and the fakes
 * mirror the one behaviour that makes the annotation-layer change a data-loss
 * bug rather than a type error: a missing storage is quietly replaced by a
 * private one.
 */

const { state } = vi.hoisted(() => ({
  state: {
    getDocumentParams: null as Record<string, unknown> | null,
    renderParams: [] as Record<string, unknown>[],
    annotationLayerParams: [] as Record<string, unknown>[],
    annotationRenderParams: [] as Record<string, unknown>[],
    textLayerParams: [] as Record<string, unknown>[],
    loadingTasksDestroyed: 0,
  },
}));

vi.mock('./setupWorker', () => ({
  ensureWorker: () => {},
  pdfWasmUrl: () => 'https://folio.test/pdfjs-wasm/',
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  class AnnotationStorage {
    private values = new Map<string, unknown>();
    get size(): number {
      return this.values.size;
    }
    setValue(key: string, value: unknown): void {
      this.values.set(key, value);
    }
  }

  function makeViewport(scale: number, rotation = 0) {
    const viewport = {
      scale,
      userUnit: 2,
      rotation,
      width: 100 * scale,
      height: 200 * scale,
      clone: () => makeViewport(scale, rotation),
    };
    return viewport;
  }

  const page = {
    getViewport: ({ scale }: { scale: number }) => makeViewport(scale),
    render: (params: Record<string, unknown>) => {
      state.renderParams.push(params);
      return { promise: Promise.resolve(), cancel: () => {} };
    },
    getTextContent: async () => ({ items: [], styles: {} }),
    getAnnotations: async () => [],
  };

  return {
    AnnotationMode: { ENABLE: 1, ENABLE_FORMS: 2 },
    GlobalWorkerOptions: { workerSrc: '' },

    getDocument(params: Record<string, unknown>) {
      state.getDocumentParams = params;
      const doc = {
        numPages: 1,
        fingerprints: ['fingerprint'],
        annotationStorage: new AnnotationStorage(),
        getPage: async () => page,
      };
      return {
        promise: Promise.resolve(doc),
        destroy: async () => {
          state.loadingTasksDestroyed += 1;
        },
      };
    },

    TextLayer: class {
      constructor(params: Record<string, unknown>) {
        state.textLayerParams.push(params);
      }
      async render(): Promise<void> {}
    },

    AnnotationLayer: class {
      private storage: AnnotationStorage;
      constructor(params: Record<string, unknown>) {
        state.annotationLayerParams.push(params);
        // Exactly what pdf.js does: no storage passed in means a private one,
        // disconnected from the document, with no error anywhere.
        this.storage = (params.annotationStorage as AnnotationStorage) ?? new AnnotationStorage();
      }
      async render(params: Record<string, unknown>): Promise<void> {
        state.annotationRenderParams.push(params);
        // Stands in for a user typing into a widget: the layer writes through
        // to whichever storage it was constructed with.
        this.storage.setValue('field-1', { value: 'typed' });
      }
    },
  };
});

import { PdfJsEngine } from './PdfJsEngine';

/** jsdom has no canvas backend; the engine only needs these two to answer. */
function stubCanvas(): void {
  HTMLCanvasElement.prototype.getContext = (() => ({
    save: () => {},
    restore: () => {},
    setTransform: () => {},
    fillRect: () => {},
    globalCompositeOperation: '',
    fillStyle: '',
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
}

async function loadEngine(): Promise<PdfJsEngine> {
  const engine = new PdfJsEngine();
  await engine.loadDocument({ kind: 'bytes', data: new Uint8Array([1, 2, 3]), name: 'a.pdf' });
  return engine;
}

describe('PdfJsEngine on the PDF.js 6 API', () => {
  beforeEach(() => {
    state.getDocumentParams = null;
    state.renderParams = [];
    state.annotationLayerParams = [];
    state.annotationRenderParams = [];
    state.textLayerParams = [];
    state.loadingTasksDestroyed = 0;
    stubCanvas();
  });

  it('tells the worker where the WASM decoders live', async () => {
    await loadEngine();
    expect(state.getDocumentParams?.wasmUrl).toBe('https://folio.test/pdfjs-wasm/');
  });

  it('renders through the canvas, not a bare 2D context', async () => {
    const engine = await loadEngine();
    const canvas = document.createElement('canvas');
    await engine.renderPage(1, { scale: 1, canvas });

    expect(state.renderParams[0].canvas).toBe(canvas);
  });

  it('rasterises to an image through the canvas too', async () => {
    const engine = await loadEngine();
    await engine.renderPageToImage(1, 1);

    expect(state.renderParams[0].canvas).toBeInstanceOf(HTMLCanvasElement);
  });

  it('closes a document by destroying its loading task', async () => {
    const engine = await loadEngine();
    await engine.closeDocument();

    expect(state.loadingTasksDestroyed).toBe(1);
    expect(engine.isReady).toBe(false);
  });

  it('does not destroy the same loading task twice', async () => {
    const engine = await loadEngine();
    await Promise.all([engine.closeDocument(), engine.closeDocument()]);

    expect(state.loadingTasksDestroyed).toBe(1);
  });

  it('gives the annotation layer a link service at construction time', async () => {
    const engine = await loadEngine();
    await engine.renderAnnotationLayer(1, document.createElement('div'), { scale: 1 });

    // A Link annotation calls this during render(); a null link service is the
    // "cannot read properties of null" that used to reject the whole pass.
    const linkService = state.annotationLayerParams[0].linkService as Record<string, unknown>;
    expect(typeof linkService?.getDestinationHash).toBe('function');
  });

  it('binds the annotation layer to the document own storage, so edits are counted', async () => {
    const engine = await loadEngine();
    expect(engine.getPendingEditCount()).toBe(0);

    await engine.renderAnnotationLayer(1, document.createElement('div'), { scale: 1 });

    // Fails if the storage went to render() instead of the constructor: the
    // layer would have written into a private storage and saveDocument() would
    // serialise the field empty.
    expect(engine.getPendingEditCount()).toBe(1);
  });

  it('declares the scale the v6 layer CSS reads on both layers', async () => {
    const engine = await loadEngine();
    const textContainer = document.createElement('div');
    const formsContainer = document.createElement('div');

    await engine.renderTextLayer(1, textContainer, { scale: 1.5 });
    await engine.renderAnnotationLayer(1, formsContainer, { scale: 1.5 });

    for (const container of [textContainer, formsContainer]) {
      // scale x the page's /UserUnit, which the fake viewport reports as 2.
      expect(container.style.getPropertyValue('--total-scale-factor')).toBe('3');
      // Without these, setLayerDimensions' round() expression is invalid and
      // the layer box computes to no size at all.
      expect(container.style.getPropertyValue('--scale-round-x')).toBe('1px');
      expect(container.style.getPropertyValue('--scale-round-y')).toBe('1px');
    }
  });
});
