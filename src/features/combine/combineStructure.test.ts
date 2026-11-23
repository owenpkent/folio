import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { combinePdfs } from './combineDocuments';

/**
 * Structure-preservation probes for combinePdfs. Each `it.fails` documents a
 * confirmed gap (the assertion describes the desired behaviour and currently
 * fails); flip to `it` when the gap is fixed. The plain `it` cases pin what
 * does survive today.
 */

async function build(tag: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const p1 = doc.addPage([300, 300]);
  const p2 = doc.addPage([300, 300]);
  doc.setTitle(`Title ${tag}`);
  doc.setAuthor(`Author ${tag}`);
  const ctx = doc.context;

  // Outline: one root item pointing at page 2.
  const item = ctx.obj({
    Title: PDFString.of(`Bookmark ${tag}`),
    Dest: [p2.ref, PDFName.of('Fit')],
  });
  const itemRef = ctx.register(item);
  const outlines = ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 });
  const outlinesRef = ctx.register(outlines);
  item.set(PDFName.of('Parent'), outlinesRef);
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

  // Internal link annotation on page 1 to page 2 (explicit /Dest).
  const link = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 100, 30],
    Border: [0, 0, 0],
    Dest: [p2.ref, PDFName.of('Fit')],
  });
  p1.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(link)]));

  // Named destination + a GoTo link that uses the name. /Names /Dests is a
  // name tree, so the pairs sit in a /Names array. A plain dictionary keyed by
  // the name is not one, and no reader resolves it.
  const dests = ctx.obj({ Names: [PDFString.of(`dest_${tag}`), [p2.ref, PDFName.of('Fit')]] });
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: dests }));
  const namedLink = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 40, 100, 60],
    A: { S: 'GoTo', D: PDFString.of(`dest_${tag}`) },
  });
  (p1.node.get(PDFName.of('Annots')) as PDFArray).push(ctx.register(namedLink));

  // Page labels: roman numerals from the first page.
  doc.catalog.set(
    PDFName.of('PageLabels'),
    ctx.obj({ Nums: [PDFNumber.of(0), ctx.obj({ S: 'r' })] }),
  );

  // A form field with the SAME name in every input, with a value.
  const form = doc.getForm();
  const tf = form.createTextField('name');
  tf.setText(`value ${tag}`);
  tf.addToPage(p1, { x: 10, y: 200, width: 100, height: 20 });
  return doc.save();
}

/**
 * The page a named destination points at (as a ref string), found by walking
 * the catalog's /Names /Dests name tree: /Names pairs, and /Kids below them.
 */
function namedDestination(doc: PDFDocument, name: string): string | undefined {
  const walk = (node: PDFDict | undefined): string | undefined => {
    if (!node) return undefined;
    const pairs = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
      const key = pairs.lookup(i);
      const isName = key instanceof PDFString || key instanceof PDFHexString;
      if (!isName || key.decodeText() !== name) continue;
      // The value is the destination array, or a dictionary holding it in /D.
      const value = pairs.lookup(i + 1);
      const dest = value instanceof PDFDict ? value.lookupMaybe(PDFName.of('D'), PDFArray) : value;
      return dest instanceof PDFArray ? dest.get(0)?.toString() : undefined;
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const found = walk(kids.lookupMaybe(i, PDFDict));
      if (found) return found;
    }
    return undefined;
  };
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  return walk(names?.lookupMaybe(PDFName.of('Dests'), PDFDict));
}

async function combined() {
  const a = await build('A');
  const b = await build('B');
  const { bytes } = await combinePdfs([
    { name: 'a.pdf', bytes: a },
    { name: 'b.pdf', bytes: b },
  ]);
  return PDFDocument.load(bytes, { updateMetadata: false });
}

describe('combinePdfs structure', () => {
  it('keeps only the first input metadata (documented behaviour)', async () => {
    const out = await combined();
    expect(out.getTitle()).toBe('Title A');
    expect(out.getAuthor()).toBe('Author A');
  });

  it('merges same-named form fields with their values and de-duplicates the name', async () => {
    const out = await combined();
    const fields = out.getForm().getFields();
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.getName()).sort()).toEqual(['name', 'name (2)']);
  });

  // GAP: the merged catalog is built from scratch; nothing copies /Outlines.
  it.fails('preserves document outlines (bookmarks) of every input', async () => {
    const out = await combined();
    expect(out.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)).toBeDefined();
  });

  // GAP: /Names /Dests (and /Dests) are never copied, so GoTo-by-name links dangle.
  it.fails('preserves named destinations', async () => {
    const out = await combined();
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    expect(namedDestination(out, 'dest_A')).toBe(pageRefs[1]);
    expect(namedDestination(out, 'dest_B')).toBe(pageRefs[3]);
  });

  // Guards the fixture: if the name did not resolve in the input, the gap test
  // above would be failing for the wrong reason (it once did).
  it('builds inputs whose named destination resolves to their second page', async () => {
    const input = await PDFDocument.load(await build('A'), { updateMetadata: false });
    expect(namedDestination(input, 'dest_A')).toBe(input.getPage(1).ref.toString());
    expect(namedDestination(input, 'dest_B')).toBeUndefined();
  });

  // GAP: /PageLabels are never copied.
  it.fails('preserves page labels', async () => {
    const out = await combined();
    expect(out.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict)).toBeDefined();
  });

  // Link annotations ride along with the page, and the copier follows /Dest
  // page refs, so an explicit /Dest should resolve to a page of the merged doc.
  it('keeps explicit-destination links pointing at the copied page', async () => {
    const out = await combined();
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    let found = false;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      const dest = a.lookupMaybe(PDFName.of('Dest'), PDFArray);
      if (dest) {
        found = true;
        expect(pageRefs).toContain(dest.get(0)!.toString());
      }
    }
    expect(found).toBe(true);
  });
});
