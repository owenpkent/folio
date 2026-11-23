// @vitest-environment node
import { PDFDocument, PDFHexString, PDFName, type PDFObject, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { combinePdfs } from './combineDocuments';

/**
 * Named destinations as a reader resolves them, which is the only test that
 * counts for a link: these run the combined bytes through PDF.js, Folio's own
 * reader, and follow each link the way the viewer does (the link's decoded
 * name handed to `getDestination`). pdf-lib-level checks of the same code are
 * in combineStructure.test.ts; they cannot see a name that is byte-different
 * and reader-identical, which is what several of these are about.
 *
 * Node environment: PDF.js parses on its in-process fake worker, with no
 * canvas, since nothing is rendered.
 */

/**
 * A two-page input. `key` names its second page in the `/Names` `/Dests` name
 * tree; `link` is what the link on its first page asks for, as a `/Dest` or,
 * with `action`, as a `/GoTo` action's `/D`.
 */
async function input(key?: PDFObject, link?: PDFObject, action = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const first = doc.addPage([300, 300]);
  const second = doc.addPage([300, 300]);
  const ctx = doc.context;
  if (key) {
    const names = ctx.obj({ Names: [key, [second.ref, PDFName.of('Fit')]] });
    doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: names }));
  }
  if (link) {
    const target = action ? { A: { S: 'GoTo', D: link } } : { Dest: link };
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], ...target });
    first.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  }
  return doc.save();
}

/**
 * Where each link in `bytes` lands when PDF.js follows it: the 0-based page
 * index, or null for a link that resolves to nothing. One entry per page that
 * has a link, in page order.
 */
async function linkTargets(bytes: Uint8Array): Promise<Array<number | null>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const targets: Array<number | null> = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const annotations = await (await pdf.getPage(pageNumber)).getAnnotations();
      const link = annotations.find((annotation) => annotation.subtype === 'Link');
      if (!link) continue;
      const dest: unknown =
        typeof link.dest === 'string' ? await pdf.getDestination(link.dest) : link.dest;
      targets.push(Array.isArray(dest) ? await pdf.getPageIndex(dest[0]) : null);
    }
    return targets;
  } finally {
    await task.destroy();
  }
}

async function combinedTargets(...inputs: Uint8Array[]): Promise<Array<number | null>> {
  const { bytes } = await combinePdfs(
    inputs.map((data, index) => ({ name: `in${index}.pdf`, bytes: data })),
  );
  return linkTargets(bytes);
}

const ascii = () => PDFString.of('intro');
/** The same five letters as UTF-16BE with a byte-order mark. */
const utf16 = () => PDFHexString.of('FEFF0069006E00740072006F');

describe('named destinations, as PDF.js resolves them', () => {
  it('follows every link to its own file when both files use the same name', async () => {
    const one = await input(ascii(), ascii());
    expect(await linkTargets(one)).toEqual([1]);
    expect(await combinedTargets(one, await input(ascii(), ascii()))).toEqual([1, 3]);
  });

  it('follows a renamed GoTo action', async () => {
    const make = () => input(ascii(), ascii(), true);
    expect(await combinedTargets(await make(), await make())).toEqual([1, 3]);
  });

  // The same name written two ways is one name to a reader, which decodes
  // before it compares. Told apart by their bytes, both were kept, and the
  // second file's link landed in the first file.
  it('treats one name in two encodings as a clash', async () => {
    const plain = await input(ascii(), ascii());
    const wide = await input(utf16(), utf16());
    expect(await linkTargets(wide)).toEqual([1]);
    expect(await combinedTargets(plain, wide)).toEqual([1, 3]);
    expect(await combinedTargets(wide, plain)).toEqual([1, 3]);
  });

  // A suffix has to be encoded like the name it is added to. ASCII digits
  // appended to UTF-16 bytes pair up into other characters, and ~10 and ~11
  // decoded to the same one.
  it('keeps eleven copies of a UTF-16 name apart', async () => {
    const copies = await Promise.all(Array.from({ length: 11 }, () => input(utf16(), utf16())));
    expect(await combinedTargets(...copies)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  });

  // Each of these is a legal way to write the name, and the link finds it in
  // the input on its own. Combined with a file that has no names at all, it
  // has to go on finding it.
  it.each([
    ['white space inside a hex string', () => PDFHexString.of('69 6e74726f'), ascii],
    [
      'an odd number of hex digits',
      () => PDFHexString.of('696e74726f7'),
      () => PDFString.of('introp'),
    ],
    ['a backslash-newline continuation', () => PDFString.of('in\\\r\ntro'), ascii],
    ['an octal escape', () => PDFString.of('in\\164ro'), ascii],
    ['a literal key and a hex link', ascii, () => PDFHexString.of('696E74726F')],
    [
      'a non-ASCII name in PDFDocEncoding',
      () => PDFHexString.of('636166E9'),
      () => PDFHexString.of('636166E9'),
    ],
  ])('still resolves a name written with %s', async (_spelling, key, link) => {
    const one = await input(key(), link());
    expect(await linkTargets(one)).toEqual([1]);
    expect(await combinedTargets(one, await input())).toEqual([1]);
    expect(await combinedTargets(await input(), one)).toEqual([3]);
  });

  // A file split out of a larger one keeps links to names it no longer
  // defines. They were dead in that file and stay dead, whichever side of the
  // file that does define the name it is combined on.
  it('does not let a link to an undefined name resolve into another file', async () => {
    const dangling = () => input(undefined, ascii());
    const defining = () => input(ascii(), ascii());
    expect(await linkTargets(await dangling())).toEqual([null]);
    expect(await combinedTargets(await dangling(), await defining())).toEqual([null, 3]);
    expect(await combinedTargets(await defining(), await dangling())).toEqual([1, null]);
    // In another encoding too: the reader would have matched it by its text.
    expect(await combinedTargets(await input(undefined, utf16()), await defining())).toEqual([
      null,
      3,
    ]);
  });
});
