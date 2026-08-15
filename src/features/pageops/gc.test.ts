// @vitest-environment node
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  type PDFRef,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { findDanglingRefs, sweepDroppedPages } from './gc';

describe('sweepDroppedPages and number/name trees', () => {
  it('keeps a /Nums number tree correctly paired around a dropped entry', async () => {
    // Mirrors /StructTreeRoot /ParentTree /Nums: a flat [key, value, key,
    // value, ...] array where a value is some indirect object (a struct
    // element, in the real structure) and position is the only thing pairing
    // a key with its neighbour.
    const doc = await PDFDocument.create();
    const { context } = doc;

    const kept0 = context.register(context.obj({ Marker: 'kept0' }));
    const dropped1 = context.register(context.obj({ Marker: 'dropped1' }));
    const kept2 = context.register(context.obj({ Marker: 'kept2' }));

    const nums = context.obj([0, kept0, 1, dropped1, 2, kept2]) as PDFArray;
    const parentTreeRef = context.register(context.obj({ Nums: nums }));
    const structRootRef = context.register(context.obj({ ParentTree: parentTreeRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRootRef);

    sweepDroppedPages(context, [dropped1]);

    const rebuilt = context.lookup(parentTreeRef, PDFDict).lookup(PDFName.of('Nums'), PDFArray);
    // Six entries in, four out: the dead pair is gone entirely, not just its
    // value -- which would leave key 1 mapping to the integer 2 (what used to
    // be key 2's own key, shifted down one slot) and key 2's value orphaned.
    expect(rebuilt.size()).toBe(4);
    const pairs: Array<[number, PDFRef]> = [];
    for (let index = 0; index < rebuilt.size(); index += 2) {
      pairs.push([rebuilt.lookup(index, PDFNumber).asNumber(), rebuilt.get(index + 1) as PDFRef]);
    }
    expect(pairs).toEqual([
      [0, kept0],
      [2, kept2],
    ]);
  });

  it('drops a /Names /Dests entry whole when its destination targets a dropped page', async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const page = doc.addPage([300, 400]);

    const destArray = context.obj([page.ref, 'XYZ', null, 700, null]) as PDFArray;
    const names = context.obj([PDFString.of('chap1'), destArray]) as PDFArray;
    const destsRef = context.register(context.obj({ Names: names }));
    const namesDictRef = context.register(context.obj({ Dests: destsRef }));
    doc.catalog.set(PDFName.of('Names'), namesDictRef);

    sweepDroppedPages(context, [page.ref]);

    const rebuilt = context.lookup(destsRef, PDFDict).lookup(PDFName.of('Names'), PDFArray);
    // The whole (name, destination) pair is gone. Slicing just the page ref
    // out of the destination array would leave [/XYZ null 700 null], which
    // reads as a destination to page 0.
    expect(rebuilt.size()).toBe(0);
  });

  it('drops a /Dest that is an indirect reference to a destination array', async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const page = doc.addPage([300, 400]);

    const destArrayRef = context.register(context.obj([page.ref, 'Fit']));
    const linkAnnotRef = context.register(context.obj({ Subtype: 'Link', Dest: destArrayRef }));
    // Any live path reaches this; a made-up catalog key stands in for
    // /Annots, /AcroForm, or whatever a real document would route it through.
    doc.catalog.set(PDFName.of('LinkForTest'), linkAnnotRef);

    sweepDroppedPages(context, [page.ref]);

    const reloaded = context.lookup(linkAnnotRef, PDFDict);
    expect(reloaded.get(PDFName.of('Dest'))).toBeUndefined();
  });
});

describe('findDanglingRefs', () => {
  it('finds nothing in an ordinary document', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 400]);
    expect(findDanglingRefs(doc.context)).toEqual([]);
  });

  it('finds a reachable ref that does not resolve to a real object', async () => {
    const doc = await PDFDocument.create();
    const { context } = doc;
    const ghost = context.nextRef(); // allocated, never assigned an object
    doc.catalog.set(PDFName.of('LinkForTest'), ghost);

    expect(findDanglingRefs(context)).toEqual([ghost]);
  });

  it('does not flag a ref that sweepDroppedPages was told to drop', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 400]);

    sweepDroppedPages(doc.context, [page.ref]);

    // Nothing still reachable points at the dropped page: findDanglingRefs
    // only reports refs that survive scrubbing and still fail to resolve.
    expect(findDanglingRefs(doc.context)).toEqual([]);
  });
});
