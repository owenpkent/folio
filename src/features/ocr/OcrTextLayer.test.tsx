import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OcrTextLayer } from './OcrTextLayer';
import { useOcrStore } from './store';

const LAYER_WIDTH = 600;
const LAYER_HEIGHT = 800;
/** What jsdom is told every word measures before it is scaled. */
const NATURAL_WIDTH = 40;

/**
 * jsdom does no layout: every box is 0x0 and every getBoundingClientRect is
 * empty, which is exactly the case the component treats as "not laid out yet".
 * These stubs stand in for the one measurement the scaling depends on.
 */
function stubLayout(naturalWidth = NATURAL_WIDTH) {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => LAYER_WIDTH,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => LAYER_HEIGHT,
  });
  HTMLElement.prototype.getBoundingClientRect = vi.fn(
    () => ({ width: naturalWidth, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect,
  );
}

function setWords(words: { text: string; rect: { x: number; y: number; w: number; h: number } }[]) {
  useOcrStore.setState({
    pages: {
      1: {
        pageNumber: 1,
        text: words.map((w) => w.text).join(' '),
        words: words.map((w) => ({
          text: w.text,
          rect: { x: w.rect.x, y: w.rect.y, width: w.rect.w, height: w.rect.h },
        })),
      },
    },
  });
}

describe('OcrTextLayer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    stubLayout();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useOcrStore.setState({ pages: {} });
    Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    // Assigning to HTMLElement.prototype puts an own property in front of the
    // real Element.prototype method, and vi.unstubAllGlobals does not undo a
    // direct prototype assignment. Left in place it would outlive this file and
    // report every element in the worker as 40x0.
    Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect');
  });

  it('stretches each word onto its recognized width', () => {
    // 0.2 of a 600px page is 120px; the browser lays the word out at 40px, so
    // the highlight would sit a third of the width it should cover without a
    // scale. This is the bug the layer exists to correct.
    setWords([{ text: 'Congratulations,', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 } }]);
    render(<OcrTextLayer pageNumber={1} />);

    const span = document.querySelector<HTMLElement>('.folio-ocr-word');
    expect(span?.style.transform).toBe(`scaleX(${(0.2 * LAYER_WIDTH) / NATURAL_WIDTH})`);
  });

  it('scales each word independently, so error does not accumulate along a line', () => {
    setWords([
      { text: 'Please', rect: { x: 0.1, y: 0.1, w: 0.1, h: 0.02 } },
      { text: 'take', rect: { x: 0.25, y: 0.1, w: 0.05, h: 0.02 } },
    ]);
    render(<OcrTextLayer pageNumber={1} />);

    const spans = document.querySelectorAll<HTMLElement>('.folio-ocr-word');
    expect(spans[0].style.transform).toBe(`scaleX(${(0.1 * LAYER_WIDTH) / NATURAL_WIDTH})`);
    expect(spans[1].style.transform).toBe(`scaleX(${(0.05 * LAYER_WIDTH) / NATURAL_WIDTH})`);
  });

  it('sizes a word to the full height of its box, so the highlight covers it', () => {
    setWords([{ text: 'approved', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.025 } }]);
    render(<OcrTextLayer pageNumber={1} />);

    const span = document.querySelector<HTMLElement>('.folio-ocr-word');
    expect(span?.style.fontSize).toBe(`${0.025 * LAYER_HEIGHT}px`);
  });

  it('measures itself when the page is recognized after the layer has mounted', () => {
    // The ordinary path: the layer is mounted for every page as soon as a
    // document opens and renders nothing until OCR runs, so the element it
    // measures does not exist on the first pass. Measuring only on mount left
    // the layer at 0x0 for good, which is every word at the 1px floor and
    // none of them scaled.
    render(<OcrTextLayer pageNumber={1} />);

    act(() => {
      setWords([{ text: 'Congratulations,', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 } }]);
    });

    const span = document.querySelector<HTMLElement>('.folio-ocr-word');
    expect(span?.style.transform).toBe(`scaleX(${(0.2 * LAYER_WIDTH) / NATURAL_WIDTH})`);
    expect(span?.style.fontSize).toBe(`${0.02 * LAYER_HEIGHT}px`);
  });

  it('clamps an unscaled word to its box rather than writing an infinite scale', () => {
    // A word the browser reports as zero-width has not been laid out yet;
    // dividing into that measurement yields scaleX(Infinity). Unscaled still
    // has to be clipped to the recognized box, or the selection highlight
    // spills over the words after it.
    stubLayout(0);
    setWords([{ text: 'approved', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.02 } }]);
    render(<OcrTextLayer pageNumber={1} />);

    const span = document.querySelector<HTMLElement>('.folio-ocr-word');
    expect(span?.style.transform).toBe('none');
    expect(span?.style.maxWidth).toBe(`${0.2 * LAYER_WIDTH}px`);
    expect(span?.style.overflow).toBe('hidden');
  });

  it('renders nothing for a page with no recognized words', () => {
    useOcrStore.setState({ pages: {} });
    const { container } = render(<OcrTextLayer pageNumber={1} />);

    expect(container.firstChild).toBeNull();
  });
});
