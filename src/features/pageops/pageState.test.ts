import { beforeEach, describe, expect, it } from 'vitest';

import { useAnnotationStore } from '@/features/annotations/store';
import type { Annotation } from '@/features/annotations/types';
import { useEditStore } from '@/features/editing/store';
import type { TextEdit } from '@/features/editing/types';
import { useOcrStore } from '@/features/ocr/store';
import type { OcrPage } from '@/features/ocr/types';
import { useSignatureStore } from '@/features/signatures/store';
import type { Signature } from '@/features/signatures/types';

import { capturePageState, remapPageState, restorePageState, undoPageState } from './pageState';

const rect = (x: number) => ({ x, y: 0.2, width: 0.3, height: 0.4 });

const textEdit = (id: string, pageNumber: number): TextEdit => ({
  id,
  kind: 'text',
  pageNumber,
  rect: rect(0.1),
  createdAt: 0,
  text: id,
  fontFamily: 'Helvetica',
  bold: false,
  fontSizePt: 14,
  colorHex: '#111111',
});

const signature = (id: string, pageNumber: number): Signature => ({
  id,
  pageNumber,
  dataUrl: 'data:image/png;base64,',
  rect: rect(0.1),
  createdAt: 0,
});

const highlight = (id: string, pageNumber: number): Annotation => ({
  id,
  type: 'highlight',
  pageNumber,
  color: '#ff0',
  rects: [rect(0.1), rect(0.5)],
  createdAt: 0,
});

const note = (id: string, pageNumber: number): Annotation => ({
  id,
  type: 'note',
  pageNumber,
  color: '#ff0',
  rects: [],
  anchor: { x: 0.25, y: 0.5 },
  createdAt: 0,
});

const ocrPage = (pageNumber: number): OcrPage => ({
  pageNumber,
  text: `page ${pageNumber}`,
  words: [{ text: 'hello', rect: rect(0.1) }],
});

/** Pages 1, 2 and 3, each carrying one of everything. */
function seed(): void {
  useEditStore.getState().replaceAll([textEdit('e1', 1), textEdit('e2', 2), textEdit('e3', 3)]);
  useSignatureStore
    .getState()
    .replaceAll([signature('s1', 1), signature('s2', 2), signature('s3', 3)]);
  useAnnotationStore.getState().replaceAll([highlight('h1', 1), highlight('h2', 2), note('n3', 3)]);
  useOcrStore.getState().replaceAll({ 1: ocrPage(1), 2: ocrPage(2), 3: ocrPage(3) });
}

const editPages = () => useEditStore.getState().edits.map((e) => [e.id, e.pageNumber]);

describe('remapPageState', () => {
  beforeEach(() => {
    useEditStore.getState().reset();
    useSignatureStore.getState().reset();
    useAnnotationStore.getState().reset();
    useOcrStore.getState().reset();
    seed();
  });

  it('moves everything to its page new number', () => {
    // Pages reversed: 1 -> 3, 2 -> 2, 3 -> 1.
    remapPageState(
      new Map([
        [1, 3],
        [2, 2],
        [3, 1],
      ]),
    );

    expect(editPages()).toEqual([
      ['e1', 3],
      ['e2', 2],
      ['e3', 1],
    ]);
    expect(useSignatureStore.getState().signatures.map((s) => s.pageNumber)).toEqual([3, 2, 1]);
    expect(useAnnotationStore.getState().annotations.map((a) => a.pageNumber)).toEqual([3, 2, 1]);
  });

  it('rekeys the OCR record and the page number inside it', () => {
    remapPageState(new Map([[3, 1]]));

    const { pages } = useOcrStore.getState();
    expect(Object.keys(pages)).toEqual(['1']);
    expect(pages[1].pageNumber).toBe(1);
    expect(pages[1].text).toBe('page 3');
  });

  it('drops whatever sat on a deleted page', () => {
    // Page 2 is gone; 3 slides up into its place.
    remapPageState(
      new Map([
        [1, 1],
        [3, 2],
      ]),
    );

    expect(editPages()).toEqual([
      ['e1', 1],
      ['e3', 2],
    ]);
    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual(['h1', 'n3']);
    expect(Object.keys(useOcrStore.getState().pages)).toEqual(['1', '2']);
  });

  it('leaves rects alone when nothing turned', () => {
    remapPageState(new Map([[1, 1]]));

    expect(useEditStore.getState().edits[0].rect).toEqual(rect(0.1));
  });

  it('carries a rect round with the page it sits on', () => {
    remapPageState(new Map([[1, 1]]), new Map([[1, 90]]));

    // A quarter turn clockwise: x becomes 1 - y - height, y becomes the old x,
    // and the sides swap.
    expect(useEditStore.getState().edits[0].rect).toEqual({
      x: 1 - 0.2 - 0.4,
      y: 0.1,
      width: 0.4,
      height: 0.3,
    });
  });

  it('turns every rect of a highlight and a note anchor', () => {
    remapPageState(
      new Map([
        [1, 1],
        [3, 3],
      ]),
      new Map([
        [1, 90],
        [3, 90],
      ]),
    );

    const annotations = useAnnotationStore.getState().annotations;
    expect(annotations[0].rects).toHaveLength(2);
    expect(annotations[0].rects[1].y).toBeCloseTo(0.5);
    expect(annotations[1].anchor).toEqual({ x: 0.5, y: 0.25 });
  });

  it('turns OCR words too, so the text layer stays over its text', () => {
    remapPageState(new Map([[2, 2]]), new Map([[2, 180]]));

    expect(useOcrStore.getState().pages[2].words[0].rect).toEqual({
      x: 1 - 0.1 - 0.3,
      y: 1 - 0.2 - 0.4,
      width: 0.3,
      height: 0.4,
    });
  });

  it('only turns the pages the plan turned', () => {
    remapPageState(
      new Map([
        [1, 1],
        [2, 2],
      ]),
      new Map([[1, 90]]),
    );

    expect(useEditStore.getState().edits[0].rect).not.toEqual(rect(0.1));
    expect(useEditStore.getState().edits[1].rect).toEqual(rect(0.1));
  });
});

describe('capturePageState / restorePageState', () => {
  beforeEach(() => {
    useEditStore.getState().reset();
    useSignatureStore.getState().reset();
    useAnnotationStore.getState().reset();
    useOcrStore.getState().reset();
    seed();
  });

  it('puts back everything a plan disturbed', () => {
    const snapshot = capturePageState(new Uint8Array([1, 2, 3]), 3);

    remapPageState(new Map([[1, 1]]));
    expect(editPages()).toEqual([['e1', 1]]);

    restorePageState(snapshot);

    expect(editPages()).toEqual([
      ['e1', 1],
      ['e2', 2],
      ['e3', 3],
    ]);
    expect(useSignatureStore.getState().signatures).toHaveLength(3);
    expect(useAnnotationStore.getState().annotations).toHaveLength(3);
    expect(Object.keys(useOcrStore.getState().pages)).toEqual(['1', '2', '3']);
  });

  it('is not disturbed by a later remap', () => {
    const snapshot = capturePageState(new Uint8Array(), 3);
    remapPageState(new Map([[2, 9]]), new Map([[2, 90]]));

    // The snapshot copied the collections, so the store's new arrays and the
    // turned rects inside them cannot reach back into it.
    expect(snapshot.edits.map((e) => e.pageNumber)).toEqual([1, 2, 3]);
    expect(snapshot.edits[1].rect).toEqual(rect(0.1));
  });
});

/** toEqual on a rect that has been through a rotation and back. */
function expectRect(actual: ReturnType<typeof rect>, expected: ReturnType<typeof rect>): void {
  expect(actual.x).toBeCloseTo(expected.x);
  expect(actual.y).toBeCloseTo(expected.y);
  expect(actual.width).toBeCloseTo(expected.width);
  expect(actual.height).toBeCloseTo(expected.height);
}

describe('undoPageState', () => {
  beforeEach(() => {
    useEditStore.getState().reset();
    useSignatureStore.getState().reset();
    useAnnotationStore.getState().reset();
    useOcrStore.getState().reset();
    seed();
  });

  /** Run a plan the way commitPagePlan does: capture, remap, record the plan. */
  function commit(pageMap: Map<number, number>, turns?: Map<number, number>) {
    const snapshot = capturePageState(new Uint8Array(), 3);
    remapPageState(pageMap, turns);
    snapshot.pageMap = pageMap;
    snapshot.turns = turns;
    return snapshot;
  }

  it('keeps a signature placed after the operation, on the page it was placed on', () => {
    // Delete page 1: pages 2 and 3 become 1 and 2.
    const snapshot = commit(
      new Map([
        [2, 1],
        [3, 2],
      ]),
    );
    // Placed on what is now page 2, which was page 3.
    useSignatureStore
      .getState()
      .replaceAll([...useSignatureStore.getState().signatures, signature('later', 2)]);

    undoPageState(snapshot);

    const pages = Object.fromEntries(
      useSignatureStore.getState().signatures.map((s) => [s.id, s.pageNumber]),
    );
    expect(pages).toEqual({ s1: 1, s2: 2, s3: 3, later: 3 });
  });

  it('brings back only what sat on the deleted page, from the snapshot', () => {
    const snapshot = commit(
      new Map([
        [2, 1],
        [3, 2],
      ]),
    );
    expect(editPages()).toEqual([
      ['e2', 1],
      ['e3', 2],
    ]);

    undoPageState(snapshot);

    expect(editPages().sort()).toEqual([
      ['e1', 1],
      ['e2', 2],
      ['e3', 3],
    ]);
    expect(Object.keys(useOcrStore.getState().pages).sort()).toEqual(['1', '2', '3']);
    expect(useOcrStore.getState().pages[1].text).toBe('page 1');
  });

  it('leaves an item the user removed after the operation removed', () => {
    const snapshot = commit(
      new Map([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    );
    useAnnotationStore
      .getState()
      .replaceAll(useAnnotationStore.getState().annotations.filter((a) => a.id !== 'h2'));

    undoPageState(snapshot);

    expect(useAnnotationStore.getState().annotations.map((a) => a.id)).toEqual(['h1', 'n3']);
  });

  it('turns a rect placed on a rotated page back with the page', () => {
    const snapshot = commit(
      new Map([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
      new Map([[2, 90]]),
    );
    const placed = rect(0.1);
    useEditStore.getState().replaceAll([...useEditStore.getState().edits, textEdit('later', 2)]);

    undoPageState(snapshot);

    const edits = Object.fromEntries(useEditStore.getState().edits.map((e) => [e.id, e.rect]));
    // Turned 90 and back: where it was, to floating-point rounding.
    expectRect(edits.e2, rect(0.1));
    // Placed on the turned page, so turning back moves it the other way.
    expect(edits.later).not.toEqual(placed);
    expect(edits.later.width).toBeCloseTo(placed.height);
    expect(edits.later.height).toBeCloseTo(placed.width);
    // Words too.
    expectRect(useOcrStore.getState().pages[2].words[0].rect, rect(0.1));
  });

  it('reverses a reorder, carrying later work to the page it is on', () => {
    // Reverse the pages.
    const snapshot = commit(
      new Map([
        [1, 3],
        [2, 2],
        [3, 1],
      ]),
    );
    useSignatureStore
      .getState()
      .replaceAll([...useSignatureStore.getState().signatures, signature('later', 1)]);

    undoPageState(snapshot);

    const pages = Object.fromEntries(
      useSignatureStore.getState().signatures.map((s) => [s.id, s.pageNumber]),
    );
    // 'later' went on page 1, which was page 3 before the reorder.
    expect(pages).toEqual({ s1: 1, s2: 2, s3: 3, later: 3 });
  });

  it('falls back to a plain restore for a snapshot that records no plan', () => {
    const snapshot = capturePageState(new Uint8Array(), 3);
    remapPageState(new Map([[1, 1]]));
    useSignatureStore.getState().replaceAll([signature('later', 1)]);

    undoPageState(snapshot);

    expect(useSignatureStore.getState().signatures.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });
});
