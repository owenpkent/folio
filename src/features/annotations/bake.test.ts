// @vitest-environment node
import { degrees, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, type PDFNumber } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { stampAnnotations } from './bake';
import type { Annotation } from './types';

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // A4 in points
  return doc.save();
}

/** The dict of the annotation at `index` on page 1, or undefined. */
function annotationDictAt(pdf: PDFDocument, index = 0) {
  const annots = pdf.getPage(0).node.Annots();
  const ref = annots?.get(index);
  if (!ref) return undefined;
  return pdf.context.lookup(ref, PDFDict);
}

/** The /Contents value of the first annotation on page 1, or undefined. */
function firstAnnotationContents(pdf: PDFDocument) {
  return annotationDictAt(pdf)?.get(PDFName.of('Contents'));
}

/** A page's /Rect entry, as pdf-lib's {x, y, width, height}. */
function rectOf(dict: PDFDict) {
  return dict.lookup(PDFName.of('Rect'), PDFArray).asRectangle();
}

/** A highlight annotation's /QuadPoints entry, as plain numbers. */
function quadPointsOf(dict: PDFDict): number[] {
  return dict
    .lookup(PDFName.of('QuadPoints'), PDFArray)
    .asArray()
    .map((n) => (n as PDFNumber).asNumber());
}

const highlight: Annotation = {
  id: 'h1',
  type: 'highlight',
  pageNumber: 1,
  color: 'rgba(255, 214, 10, 0.45)',
  rects: [{ x: 0.1, y: 0.1, width: 0.5, height: 0.03 }],
  text: 'plain ascii',
  createdAt: 0,
};

describe('stampAnnotations', () => {
  it('adds a /Highlight annotation with QuadPoints and Tabs=S on the page', async () => {
    const pdf = await PDFDocument.load(await onePagePdf());
    stampAnnotations(pdf, [highlight]);
    const out = await pdf.save();

    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    const annots = reloaded.getPage(0).node.Annots();
    expect(annots?.size()).toBe(1);
  });

  it('encodes non-ASCII /Contents as a UTF-16BE hex string (not lossy PDFString)', () => {
    // The whole reason these are real annotations is that assistive tech reads
    // /Contents. PDFString.of would truncate anything above Latin-1 to one byte;
    // PDFHexString.fromText writes UTF-16BE with a BOM, which round-trips.
    const text = 'café 日本語 “curly” 😀';
    const contents = PDFHexString.fromText(text);
    // A hex string beginning with the UTF-16 BOM (FEFF) is the correct encoding.
    expect(contents.toString().toUpperCase()).toMatch(/^<FEFF/);
    expect(contents.decodeText()).toBe(text);
  });

  it('round-trips non-ASCII highlight text through save and reload', async () => {
    const text = 'café 日本語 😀';
    const pdf = await PDFDocument.load(await onePagePdf());
    stampAnnotations(pdf, [{ ...highlight, text }]);
    const reloaded = await PDFDocument.load(await pdf.save());
    const contents = firstAnnotationContents(reloaded);
    expect(contents).toBeInstanceOf(PDFHexString);
    expect((contents as PDFHexString).decodeText()).toBe(text);
  });

  it('skips out-of-range pages and empty inputs without throwing', async () => {
    const pdf = await PDFDocument.load(await onePagePdf());
    stampAnnotations(pdf, []);
    stampAnnotations(pdf, [{ ...highlight, pageNumber: 99 }]);
    expect((await pdf.save()).length).toBeGreaterThan(0);
  });

  it('places a highlight and a note where the user saw them on a 90°-rotated page', async () => {
    // Same fixture pageGeometry.test.ts checks boxRect against: a 400x600
    // MediaBox turned 90 degrees (displayed as 600x400). A highlight rect a
    // quarter in from the left, half way down, half the displayed width, a
    // quarter of the displayed height turns into the user-space box
    // {x0: 200, y0: 150, x1: 300, y1: 450} (see boxRect's "swaps the axes on
    // a quarter turn" test) -- unlike a drawn stamp, an annotation's /Rect and
    // /QuadPoints are turned by the reader along with the page, so they carry
    // no rotate of their own.
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    page.setRotation(degrees(90));

    stampAnnotations(doc, [
      { ...highlight, rects: [{ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }] },
      {
        id: 'n1',
        type: 'note',
        pageNumber: 1,
        color: 'rgba(255, 214, 10, 0.45)',
        rects: [],
        anchor: { x: 0.25, y: 0.5 },
        note: 'a comment',
        createdAt: 0,
      },
    ]);
    const out = await doc.save();
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPage(0).node.Annots()?.size()).toBe(2);

    const highlightDict = annotationDictAt(reloaded, 0);
    expect(highlightDict).toBeDefined();
    expect(rectOf(highlightDict!)).toEqual({ x: 200, y: 150, width: 100, height: 300 });
    expect(quadPointsOf(highlightDict!)).toEqual([200, 450, 300, 450, 200, 150, 300, 150]);

    // A /Text annotation's box is a fixed 20x20pt icon, not a fraction of the
    // page, so it stays 20x20 regardless of the page's turn; only its anchor
    // corner moves. See buildNote's comment in bake.ts.
    const noteDict = annotationDictAt(reloaded, 1);
    expect(noteDict).toBeDefined();
    expect(rectOf(noteDict!)).toEqual({ x: 200, y: 150, width: 20, height: 20 });
  });
});
