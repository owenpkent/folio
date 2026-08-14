// @vitest-environment node
import {
  decodePDFRawStream,
  degrees,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  type PDFContext,
  type PDFPage,
  type PDFRef,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { applyPagePlan, PageOpsError, verifyResult } from './mutate';

/** Distinctive markers, so a hit anywhere in the file is unambiguous. */
const FIELD_VALUE = 'SECRETFIELDVALUE123';
const STRUCT_TEXT = 'PATIENTNAMEJOHNDOE';

/** Every byte mapped 1:1 to a char code, matching how mutate.test.ts in textedit reads streams. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// pdf-lib writes drawText's operand as a hex string, so the labels below are
// matched in that form rather than as literal text. Same reason imageedit's
// mutate.test.ts carries a hex helper.
const hex = (s: string) =>
  [...s]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

const unhex = (s: string) =>
  (s.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join('');

/** Every content stream of a page, decoded and concatenated. */
function contentsOf(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  const refs =
    contents instanceof PDFArray ? contents.asArray() : [page.node.get(PDFName.of('Contents'))];
  return refs
    .map((ref) => {
      const stream = doc.context.lookup(ref);
      return stream instanceof PDFRawStream ? latin1(decodePDFRawStream(stream).decode()) : '';
    })
    .join('\n');
}

/**
 * A document whose pages each carry one recognisable word, so a plan's effect
 * can be read straight off the page contents.
 */
async function labelledPdf(labels: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of labels) {
    const page = doc.addPage([300, 400]);
    page.drawText(label, { x: 20, y: 200, size: 24, font });
  }
  return doc.save();
}

/** The label drawn on each page, in page order. */
async function readLabels(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => {
    const text = contentsOf(doc, page);
    for (const [, digits] of text.matchAll(/<([0-9A-Fa-f]+)>/g)) {
      const decoded = unhex(digits);
      if (/^PAGE-[A-Z]$/.test(decoded)) return decoded;
    }
    return '';
  });
}

/**
 * Whether a page's text still appears in any stream in the file, reachable or
 * not. This is the question `gc.ts` exists to answer "no" to.
 */
async function survivesInBytes(bytes: Uint8Array, label: string): Promise<boolean> {
  const doc = await PDFDocument.load(bytes);
  const needle = hex(label);
  return doc.context
    .enumerateIndirectObjects()
    .some(
      ([, object]) =>
        object instanceof PDFRawStream &&
        latin1(decodePDFRawStream(object).decode()).toUpperCase().includes(needle),
    );
}

/**
 * Whether the text appears anywhere in the file at all: in a stream, or as a
 * string inside any indirect object. Field values and a structure tree's
 * `/ActualText` are dictionary strings rather than stream content, so the
 * stream-only check above cannot see them.
 */
async function survivesAnywhere(bytes: Uint8Array, needle: string): Promise<boolean> {
  const doc = await PDFDocument.load(bytes);
  const hexNeedle = hex(needle);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) {
      const decoded = latin1(decodePDFRawStream(object).decode());
      if (decoded.includes(needle) || decoded.toUpperCase().includes(hexNeedle)) return true;
    }
    const rendered = object.toString();
    if (rendered.includes(needle) || rendered.toUpperCase().includes(hexNeedle)) return true;
  }
  return false;
}

describe('applyPagePlan', () => {
  it('reorders pages to match the plan', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B', 'PAGE-C', 'PAGE-D']);

    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [3, 0, 1, 2] } });

    expect(await readLabels(result.bytes)).toEqual(['PAGE-D', 'PAGE-A', 'PAGE-B', 'PAGE-C']);
    expect(result.numPages).toBe(4);
  });

  it('reports where each surviving page landed', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B', 'PAGE-C']);

    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [2, 0] } });

    // 1-based throughout: source page 3 became page 1, source page 1 became
    // page 2, and source page 2 is gone.
    expect([...result.pageMap]).toEqual([
      [3, 1],
      [1, 2],
    ]);
  });

  it('leaves the page order alone when the plan is the identity', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B', 'PAGE-C']);

    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [0, 1, 2] } });

    expect(await readLabels(result.bytes)).toEqual(['PAGE-A', 'PAGE-B', 'PAGE-C']);
  });

  it('drops pages the plan leaves out', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B', 'PAGE-C']);

    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [0, 2] } });

    expect(await readLabels(result.bytes)).toEqual(['PAGE-A', 'PAGE-C']);
    expect(result.numPages).toBe(2);
  });

  it('removes a deleted page wholesale from the saved bytes', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B', 'PAGE-C']);

    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [0, 2] } });

    // The point of the sweep: a page the user deleted is not sitting in the
    // file waiting for a parser to find it.
    expect(await survivesInBytes(result.bytes, 'PAGE-B')).toBe(false);
    expect(await survivesInBytes(result.bytes, 'PAGE-A')).toBe(true);
    expect(await survivesInBytes(result.bytes, 'PAGE-C')).toBe(true);
  });

  it('is why unlinking alone is not enough', async () => {
    // Pins the pdf-lib behaviour gc.ts compensates for: removePage takes the
    // page out of the page tree, and the writer serialises it anyway.
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B']);
    const doc = await PDFDocument.load(bytes);
    doc.removePage(1);

    expect(await survivesInBytes(await doc.save(), 'PAGE-B')).toBe(true);
  });

  it('refuses to empty the document', async () => {
    const bytes = await labelledPdf(['PAGE-A']);

    await expect(applyPagePlan({ pdfBytes: bytes, plan: { order: [] } })).rejects.toThrow(
      expect.objectContaining({ name: 'PageOpsError', code: 'empty-plan' }),
    );
  });

  it('rejects a page index the document does not have', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B']);

    await expect(applyPagePlan({ pdfBytes: bytes, plan: { order: [0, 7] } })).rejects.toThrow(
      PageOpsError,
    );
  });

  it('rejects a plan that lists the same page twice', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B']);

    await expect(applyPagePlan({ pdfBytes: bytes, plan: { order: [1, 1] } })).rejects.toThrow(
      expect.objectContaining({ code: 'duplicate-page' }),
    );
  });
});

describe('verifyResult', () => {
  // Save can overwrite the user's own file, so a plan that produced an
  // unreadable document has to fail rather than be handed on.
  it('accepts a document that reads back with the pages it should have', async () => {
    await expect(verifyResult(await labelledPdf(['PAGE-A', 'PAGE-B']), 2)).resolves.toBeUndefined();
  });

  it('refuses bytes no parser can open', async () => {
    await expect(verifyResult(new Uint8Array([1, 2, 3, 4]), 1)).rejects.toThrow(
      expect.objectContaining({ code: 'unreadable-result' }),
    );
  });

  it('refuses a document that lost pages on the way out', async () => {
    await expect(verifyResult(await labelledPdf(['PAGE-A']), 3)).rejects.toThrow(
      expect.objectContaining({ code: 'unreadable-result' }),
    );
  });

  // Page count alone only exercises the page tree -- the one structure a
  // sweep bug is least likely to touch. checkGraph re-walks the object graph
  // the same way the sweep did, and catches damage that leaves the page tree,
  // and so the count, untouched.
  describe('graph integrity (checkGraph)', () => {
    /** A document with one reachable ref that resolves to nothing. */
    async function docWithDanglingRef(): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      doc.addPage([300, 400]);
      const ghost = doc.context.nextRef(); // allocated, never assigned
      doc.catalog.set(PDFName.of('LinkForTest'), ghost);
      return doc.save();
    }

    it('accepts an ordinary document', async () => {
      await expect(
        verifyResult(await labelledPdf(['PAGE-A', 'PAGE-B']), 2, true),
      ).resolves.toBeUndefined();
    });

    it('refuses a document with a reachable dangling reference', async () => {
      await expect(verifyResult(await docWithDanglingRef(), 1, true)).rejects.toThrow(
        expect.objectContaining({ code: 'unreadable-result' }),
      );
    });

    it('is not run unless asked', async () => {
      // Same corrupt document, but checkGraph defaults to false: a plan that
      // never dropped a page never ran the sweep, so this is not a new
      // defect worth the cost, or the risk of flagging something pre-existing
      // and unrelated, of checking on every rotate and reorder too.
      await expect(verifyResult(await docWithDanglingRef(), 1)).resolves.toBeUndefined();
    });
  });
});

describe('applyPagePlan rotation', () => {
  const rotationsOf = async (bytes: Uint8Array): Promise<number[]> => {
    const doc = await PDFDocument.load(bytes);
    return doc.getPages().map((page) => page.getRotation().angle);
  };

  it('adds a quarter turn to the page it names', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B']);

    const result = await applyPagePlan({
      pdfBytes: bytes,
      plan: { order: [0, 1], rotateBy: { 1: 90 } },
    });

    expect(await rotationsOf(result.bytes)).toEqual([0, 90]);
  });

  it('turns from the page existing rotation, not from zero', async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]).setRotation(degrees(90));
    const bytes = await source.save();

    const result = await applyPagePlan({
      pdfBytes: bytes,
      plan: { order: [0], rotateBy: { 0: 90 } },
    });

    expect(await rotationsOf(result.bytes)).toEqual([180]);
  });

  it('normalises a turn back into 0-359', async () => {
    const bytes = await labelledPdf(['PAGE-A']);

    const result = await applyPagePlan({
      pdfBytes: bytes,
      plan: { order: [0], rotateBy: { 0: -90 } },
    });

    expect(await rotationsOf(result.bytes)).toEqual([270]);
  });

  it('rotates the page it names even after the plan moves it', async () => {
    const bytes = await labelledPdf(['PAGE-A', 'PAGE-B']);

    const result = await applyPagePlan({
      pdfBytes: bytes,
      plan: { order: [1, 0], rotateBy: { 0: 90 } },
    });

    // rotateBy is keyed by source index, so the turn follows PAGE-A to its new
    // position rather than landing on whatever ends up second.
    expect(await readLabels(result.bytes)).toEqual(['PAGE-B', 'PAGE-A']);
    expect(await rotationsOf(result.bytes)).toEqual([0, 90]);
  });

  it('rejects a turn that is not a multiple of 90', async () => {
    const bytes = await labelledPdf(['PAGE-A']);

    await expect(
      applyPagePlan({ pdfBytes: bytes, plan: { order: [0], rotateBy: { 0: 45 } } }),
    ).rejects.toThrow(expect.objectContaining({ code: 'bad-rotation' }));
  });

  it('rounds a non-multiple-of-90 existing rotation rather than throwing', async () => {
    // The plan's own requested turn is always validated as a multiple of 90,
    // but the page's *existing* /Rotate is not under this feature's control:
    // a malformed file, or a writer that just did not care, can leave 45
    // there. Adding 90 to that without rounding first (0deg .. 359deg, no
    // snap to a quarter turn) produces 135, which pdf-lib's setRotation
    // assertion rejects, failing every rotate on the document. setRotation
    // itself asserts the same thing, so the malformed value is written
    // directly rather than through it.
    const source = await PDFDocument.create();
    const page = source.addPage([300, 400]);
    page.node.set(PDFName.of('Rotate'), PDFNumber.of(45));
    const bytes = await source.save();

    const result = await applyPagePlan({
      pdfBytes: bytes,
      plan: { order: [0], rotateBy: { 0: 90 } },
    });

    // 45 rounds to the nearest quarter turn (90) before the requested 90 is
    // added, landing on 180 -- the same answer normalizeAngle would give if
    // asked to round the sum directly, since adding a multiple of 90 first
    // does not change which quarter turn is nearest.
    expect(await rotationsOf(result.bytes)).toEqual([180]);
  });
});

describe('applyPagePlan and catalog-level data', () => {
  /** A three-page document with an outline entry pointing at each page. */
  async function pdfWithOutline(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400]), doc.addPage([300, 400])];
    const { context } = doc;

    const outlinesRef = context.nextRef();
    const itemRefs = pages.map(() => context.nextRef());
    itemRefs.forEach((ref, index) => {
      context.assign(
        ref,
        context.obj({
          Title: PDFString.of(`Page ${index + 1}`),
          Parent: outlinesRef,
          Dest: [pages[index].ref, PDFName.of('Fit')],
          ...(index > 0 ? { Prev: itemRefs[index - 1] } : {}),
          ...(index < pages.length - 1 ? { Next: itemRefs[index + 1] } : {}),
        }),
      );
    });
    context.assign(
      outlinesRef,
      context.obj({
        Type: 'Outlines',
        First: itemRefs[0],
        Last: itemRefs[itemRefs.length - 1],
        Count: itemRefs.length,
      }),
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    return doc.save();
  }

  const outlineTitles = (doc: PDFDocument): string[] => {
    const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const titles: string[] = [];
    let ref = outlines?.get(PDFName.of('First'));
    while (ref) {
      const item = doc.context.lookupMaybe(ref, PDFDict);
      if (!item) break;
      titles.push(item.lookupMaybe(PDFName.of('Title'), PDFString)?.decodeText() ?? '');
      ref = item.get(PDFName.of('Next'));
    }
    return titles;
  };

  it('keeps the outline through a reorder', async () => {
    const result = await applyPagePlan({
      pdfBytes: await pdfWithOutline(),
      plan: { order: [2, 1, 0] },
    });

    const doc = await PDFDocument.load(result.bytes);
    expect(outlineTitles(doc)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('strips a bookmark destination that pointed at a deleted page', async () => {
    const result = await applyPagePlan({
      pdfBytes: await pdfWithOutline(),
      plan: { order: [0, 2] },
    });

    const doc = await PDFDocument.load(result.bytes);
    const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const items: PDFDict[] = [];
    let ref = outlines?.get(PDFName.of('First'));
    while (ref) {
      const item = doc.context.lookupMaybe(ref, PDFDict);
      if (!item) break;
      items.push(item);
      ref = item.get(PDFName.of('Next'));
    }

    // The entry itself survives as a heading; what it can no longer do is
    // navigate to a page that is not there.
    expect(items).toHaveLength(3);
    expect(items[1].get(PDFName.of('Dest'))).toBeUndefined();
    expect(items[0].get(PDFName.of('Dest'))).toBeDefined();
  });

  it('drops a form field whose only widget sat on a deleted page', async () => {
    const source = await PDFDocument.create();
    const pages = [source.addPage([300, 400]), source.addPage([300, 400])];
    const form = source.getForm();
    const keep = form.createTextField('keep.me');
    keep.addToPage(pages[0], { x: 10, y: 10, width: 80, height: 20 });
    const doomed = form.createTextField('doomed.field');
    doomed.addToPage(pages[1], { x: 10, y: 10, width: 80, height: 20 });

    const result = await applyPagePlan({ pdfBytes: await source.save(), plan: { order: [0] } });

    const doc = await PDFDocument.load(result.bytes);
    expect(
      doc
        .getForm()
        .getFields()
        .map((field) => field.getName()),
    ).toEqual(['keep.me']);
  });

  /**
   * A tagged document: a filled widget on page 2, plus a structure tree that
   * reaches that widget through an `/OBJR` and carries its own `/ActualText`.
   *
   * This is ordinary output from Acrobat, Word's accessible export, and
   * InDesign, and it is exactly the population where someone deletes a page to
   * get rid of what was filled into it. The structure tree is a live path to
   * the annotation that does not pass through the page, so a sweep that only
   * refuses to walk through page objects leaves the whole thing behind.
   */
  async function taggedPdfWithFilledWidget(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const form = doc.getForm();
    const field = form.createTextField('secret.field');
    field.setText(FIELD_VALUE);
    field.addToPage(pages[1], { x: 10, y: 10, width: 200, height: 20 });
    form.updateFieldAppearances();

    const { context } = doc;
    const widgetRef = pages[1].node.Annots()?.get(0) as PDFRef;
    const structRootRef = context.nextRef();
    const objrRef = context.nextRef();
    const elemRef = context.nextRef();

    context.assign(objrRef, context.obj({ Type: 'OBJR', Obj: widgetRef, Pg: pages[1].ref }));
    context.assign(
      elemRef,
      context.obj({
        Type: 'StructElem',
        S: 'Form',
        P: structRootRef,
        Pg: pages[1].ref,
        ActualText: PDFString.of(STRUCT_TEXT),
        K: [objrRef],
      }),
    );
    context.assign(structRootRef, context.obj({ Type: 'StructTreeRoot', K: [elemRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRootRef);

    return doc.save();
  }

  it('takes a deleted page filled field with it, even through a structure tree', async () => {
    const result = await applyPagePlan({
      pdfBytes: await taggedPdfWithFilledWidget(),
      plan: { order: [0] },
    });

    // /StructTreeRoot -> /K -> /OBJR -> /Obj is a live path to the widget that
    // never touches the page, so refusing to walk through page objects alone
    // leaves the field value and its rendered appearance stream in the file.
    expect(await survivesAnywhere(result.bytes, FIELD_VALUE)).toBe(false);
  });

  it('takes the structure tree text for a deleted page with it', async () => {
    const result = await applyPagePlan({
      pdfBytes: await taggedPdfWithFilledWidget(),
      plan: { order: [0] },
    });

    expect(await survivesAnywhere(result.bytes, STRUCT_TEXT)).toBe(false);
  });

  it('leaves the structure tree alone when nothing is deleted', async () => {
    const result = await applyPagePlan({
      pdfBytes: await taggedPdfWithFilledWidget(),
      plan: { order: [1, 0] },
    });

    // A reorder deletes nothing, so the tagging and the filled value stay.
    expect(await survivesAnywhere(result.bytes, STRUCT_TEXT)).toBe(true);
    expect(await survivesAnywhere(result.bytes, FIELD_VALUE)).toBe(true);
  });

  it('keeps a form field whose page survived', async () => {
    const source = await PDFDocument.create();
    const pages = [source.addPage([300, 400]), source.addPage([300, 400])];
    const form = source.getForm();
    const field = form.createTextField('survivor');
    field.addToPage(pages[1], { x: 10, y: 10, width: 80, height: 20 });

    const result = await applyPagePlan({ pdfBytes: await source.save(), plan: { order: [1] } });

    const doc = await PDFDocument.load(result.bytes);
    expect(
      doc
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toEqual(['survivor']);
  });
});

describe('applyPagePlan and every shape /K can take', () => {
  /**
   * A tagged two-page document with one structure element whose own /Pg
   * points at the page being deleted, and whose /K is built by `buildK`.
   *
   * Before the fix, structKids used context.lookupMaybe(kids, PDFArray),
   * which throws instead of returning undefined when /K exists and is not an
   * array. `K: [elemRef]` (a direct array holding one ref) is the one shape
   * that happens not to hit that: `PDFContext.lookupMaybe` never even reaches
   * its type check when the value handed in is already an array. Every case
   * below is a shape that did.
   */
  async function taggedPdfWithKShape(
    buildK: (context: PDFContext, pageRef: PDFRef) => number | PDFDict | PDFRef,
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const { context } = doc;

    const structRootRef = context.nextRef();
    const elemRef = context.nextRef();
    context.assign(
      elemRef,
      context.obj({
        Type: 'StructElem',
        S: 'Span',
        P: structRootRef,
        Pg: pages[1].ref,
        ActualText: PDFString.of(STRUCT_TEXT),
        K: buildK(context, pages[1].ref),
      }),
    );
    context.assign(structRootRef, context.obj({ Type: 'StructTreeRoot', K: [elemRef] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRootRef);

    return doc.save();
  }

  it('does not throw when /K is a bare MCID (the standard leaf shape)', async () => {
    const bytes = await taggedPdfWithKShape(() => 0);
    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [0] } });

    expect(result.numPages).toBe(1);
    expect(await survivesAnywhere(result.bytes, STRUCT_TEXT)).toBe(false);
  });

  it('does not throw when /K is a direct (non-indirect) content-item dict', async () => {
    const bytes = await taggedPdfWithKShape((context, pageRef) =>
      context.obj({ Type: 'MCR', Pg: pageRef, MCID: 0 }),
    );
    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [0] } });

    expect(result.numPages).toBe(1);
    expect(await survivesAnywhere(result.bytes, STRUCT_TEXT)).toBe(false);
  });

  it('does not throw when /K is a single indirect ref, as Word and Acrobat write it', async () => {
    const bytes = await taggedPdfWithKShape((context, pageRef) =>
      context.register(context.obj({ Type: 'MCR', Pg: pageRef, MCID: 0 })),
    );
    const result = await applyPagePlan({ pdfBytes: bytes, plan: { order: [0] } });

    expect(result.numPages).toBe(1);
    expect(await survivesAnywhere(result.bytes, STRUCT_TEXT)).toBe(false);
  });

  it('does not throw when /StructTreeRoot /K itself is a single indirect ref', async () => {
    // The literal shape the finding names: Word and Acrobat both write a
    // document with exactly one top-level structure element this way.
    const doc = await PDFDocument.create();
    const pages = [doc.addPage([300, 400]), doc.addPage([300, 400])];
    const { context } = doc;

    const structRootRef = context.nextRef();
    const elemRef = context.register(
      context.obj({
        Type: 'StructElem',
        S: 'Document',
        Pg: pages[1].ref,
        ActualText: PDFString.of(STRUCT_TEXT),
        K: 0,
      }),
    );
    context.assign(structRootRef, context.obj({ Type: 'StructTreeRoot', K: elemRef }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structRootRef);

    const result = await applyPagePlan({ pdfBytes: await doc.save(), plan: { order: [0] } });

    expect(result.numPages).toBe(1);
    expect(await survivesAnywhere(result.bytes, STRUCT_TEXT)).toBe(false);
  });
});
