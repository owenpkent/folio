// @vitest-environment node
import { PDFDocument, PDFHexString, PDFName, type PDFObject, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { combinePdfs } from './combineDocuments';

/**
 * Page labels as a reader shows them: the combined bytes go through PDF.js
 * (`getPageLabels`), which is strict about this table and gives up on the
 * whole document's labels if one entry is malformed. The pdf-lib-level checks
 * of the same code are in combineStructure.test.ts.
 *
 * Node environment, as in combineDestinations.pdfjs.test.ts.
 */

/** An input of `pages` pages, with `nums` as the pairs of its /PageLabels number tree. */
async function input(pages: number, nums?: PDFObject[] | unknown[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i++) doc.addPage([300, 300]);
  if (nums) {
    doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({ Nums: nums as never }));
  }
  return doc.save();
}

/** The label PDF.js gives each page, or null when it reports no labels at all. */
async function labelsOf(bytes: Uint8Array): Promise<string[] | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    return await pdf.getPageLabels();
  } finally {
    await task.destroy();
  }
}

async function combinedLabels(...inputs: Uint8Array[]): Promise<string[] | null> {
  const { bytes } = await combinePdfs(
    inputs.map((data, index) => ({ name: `in${index}.pdf`, bytes: data })),
  );
  return labelsOf(bytes);
}

describe('page labels, as PDF.js reads them', () => {
  it('keeps each file numbering, and restarts a file that has none at 1', async () => {
    const front = await input(3, [0, { S: 'r' }, 2, { S: 'D' }]);
    expect(await labelsOf(front)).toEqual(['i', 'ii', '1']);
    const plain = await input(2);
    const lettered = await input(3, [1, { S: 'A' }]);
    expect(await combinedLabels(front, plain, lettered)).toEqual([
      'i',
      'ii',
      '1',
      '1',
      '2',
      '1',
      'A',
      'B',
    ]);
  });

  it('reports no labels when no file has any', async () => {
    expect(await combinedLabels(await input(2), await input(2))).toBeNull();
  });

  // A prefix is copied byte for byte, however it was written: with a start
  // number, in UTF-16, with parentheses, and as a hex string with white space
  // in it (which pdf-lib's own reader pairs up wrongly).
  it('keeps a prefix and a start number', async () => {
    const one = await input(4, [
      0,
      { S: 'D', P: PDFString.of('A-'), St: 5 },
      1,
      { S: 'D', P: PDFHexString.of('FEFF00E9002D') },
      2,
      { S: 'D', P: PDFString.of('\\(x\\)') },
      3,
      { S: 'D', P: PDFHexString.of('42 2D') },
    ]);
    const expected = ['A-5', 'é-1', '(x)1', 'B-1'];
    expect(await labelsOf(one)).toEqual(expected);
    expect(await combinedLabels(await input(1), one)).toEqual(['1', ...expected]);
  });

  // One bad entry makes PDF.js drop every label in the document. Combine
  // writes only what is well-formed, so the good entries beside it survive.
  it('writes a table PDF.js accepts from one it would reject', async () => {
    const bad = await input(3, [
      0,
      { S: 'r' },
      1,
      { S: 'D', St: 0 },
      2,
      { S: PDFString.of('not a name'), P: 7 },
    ]);
    expect(await labelsOf(bad)).toBeNull();
    // Page 2 keeps its style without the bad start. Page 3 had a style that
    // is not a name and a prefix that is not a string: it gets plain decimal,
    // not the blank label that "no style" would mean.
    expect(await combinedLabels(bad, await input(1))).toEqual(['i', '1', '1', '1']);
  });

  // The same page index twice: PDF.js keeps the later entry, so combine does.
  it('takes the later of two entries for one page, as PDF.js does', async () => {
    const twice = await input(2, [0, { S: 'r' }, 0, { S: 'A' }]);
    expect(await labelsOf(twice)).toEqual(['A', 'B']);
    expect(await combinedLabels(twice, await input(1))).toEqual(['A', 'B', '1']);
  });
});
