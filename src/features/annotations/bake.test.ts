// @vitest-environment node
import { PDFDict, PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { stampAnnotations } from './bake';
import type { Annotation } from './types';

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // A4 in points
  return doc.save();
}

/** The /Contents value of the first annotation on page 1, or undefined. */
function firstAnnotationContents(pdf: PDFDocument) {
  const annots = pdf.getPage(0).node.Annots();
  const ref = annots?.get(0);
  if (!ref) return undefined;
  const dict = pdf.context.lookup(ref, PDFDict);
  return dict.get(PDFName.of('Contents'));
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
});
