// @vitest-environment node
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  rgb,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { parseContentStreams } from './contentStream';
import { TexteditError, commitTextEdit, getPageContentStreams } from './mutate';

/** Every byte mapped 1:1 to a char code, matching how pdf-lib's hex-string text operands decode. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const hex = (s: string) =>
  [...s]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

async function onePagePdfWithText(text: string, opts?: { rotate?: number }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const x = 72;
  const y = 700;
  const size = 18;
  page.drawText(text, {
    x,
    y,
    size,
    font,
    color: rgb(0, 0, 0),
    rotate: opts?.rotate !== undefined ? degrees(opts.rotate) : undefined,
  });
  const bytes = await doc.save();
  return { bytes, x, y, size };
}

/**
 * A PDF with one hand-built Form XObject (a single Tj showing formText),
 * registered under the name Fm1 and Do-invoked from every page's own
 * (hand-written) content stream. Every page names the exact same underlying
 * stream object via page.node.setXObject, the same way a real letterhead or
 * stamp is often shared across a document's pages; this is what the
 * sharing-safety test below relies on.
 */
async function pdfWithForm(opts: {
  pageCount: number;
  formText: string;
  /** The form's own /Matrix; omitted means identity. */
  matrix?: [number, number, number, number, number, number];
  /** Td inside the form's own content stream, before showing formText. Defaults to (0, 0). */
  formTd?: [number, number];
  /** Do-invocation count for page 0 only; every other page gets exactly one. */
  invocationsOnPage0?: number;
}): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const encoder = new TextEncoder();

  const [tdX, tdY] = opts.formTd ?? [0, 0];
  const formBytes = encoder.encode(`BT /F1 18 Tf ${tdX} ${tdY} Td (${opts.formText}) Tj ET`);
  const formDict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 300, 200],
    ...(opts.matrix ? { Matrix: opts.matrix } : {}),
    Resources: { Font: { F1: font.ref } },
  });
  const formRef = doc.context.register(PDFRawStream.of(formDict, formBytes));

  for (let i = 0; i < opts.pageCount; i++) {
    const page = doc.addPage([595, 842]);
    page.node.setXObject(PDFName.of('Fm1'), formRef);
    const invocations = i === 0 ? (opts.invocationsOnPage0 ?? 1) : 1;
    const pageBytes = encoder.encode(new Array(invocations).fill('/Fm1 Do').join(' '));
    const contentRef = doc.context.register(PDFRawStream.of(doc.context.obj({}), pageBytes));
    page.node.set(PDFName.of('Contents'), contentRef);
  }

  return { bytes: await doc.save() };
}

/** Decode the content stream of the Form XObject registered as `name` on the given page. */
async function formContentOnPage(
  bytes: Uint8Array,
  pageIndex: number,
  name: string,
): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const xobject = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const ref = xobject?.get(PDFName.of(name));
  const stream = doc.context.lookup(ref, PDFStream);
  const decoded = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  return latin1(decoded);
}

describe('getPageContentStreams', () => {
  it('rejects an out-of-range page index', async () => {
    const { bytes } = await onePagePdfWithText('Hello world');
    await expect(getPageContentStreams(bytes, 5)).rejects.toMatchObject({
      code: 'page-out-of-range',
    });
  });
});

describe('commitTextEdit', () => {
  it('replaces the located Tj with new text at the same origin', async () => {
    const { bytes, x, y, size } = await onePagePdfWithText('Hello world');

    const streams = await getPageContentStreams(bytes, 0);
    const before = streams.map(latin1).join('\n').toUpperCase();
    expect(before).toContain(hex('Hello world'));

    const run = parseContentStreams(streams).find((r) => r.op === 'Tj');
    expect(run).toBeDefined();
    expect(run!.x).toBeCloseTo(x);
    expect(run!.y).toBeCloseTo(y);
    expect(run!.editable).toBe(true);

    const result = await commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: run!.x, y: run!.y, op: 'Tj' },
      newText: 'Goodbye',
      style: { fontFamilyHint: 'Helvetica', fontSize: size, color: { r: 0, g: 0, b: 0 } },
    });

    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(1);

    const newStreams = await getPageContentStreams(result, 0);
    const after = newStreams.map(latin1).join('\n').toUpperCase();
    expect(after).not.toContain(hex('Hello world'));
    expect(after).toContain(hex('Goodbye'));

    const newRun = parseContentStreams(newStreams).find(
      (r) => Math.abs(r.x - x) < 1 && Math.abs(r.y - y) < 1,
    );
    expect(newRun).toBeDefined();
  });

  it('deletes the run without drawing when newText is empty', async () => {
    const { bytes, size } = await onePagePdfWithText('Hello world');
    const streams = await getPageContentStreams(bytes, 0);
    const run = parseContentStreams(streams).find((r) => r.op === 'Tj')!;

    const result = await commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: run.x, y: run.y, op: 'Tj' },
      newText: '',
      style: { fontFamilyHint: 'Helvetica', fontSize: size, color: { r: 0, g: 0, b: 0 } },
    });

    const newStreams = await getPageContentStreams(result, 0);
    expect(parseContentStreams(newStreams)).toHaveLength(0);
    const after = newStreams.map(latin1).join('\n').toUpperCase();
    expect(after).not.toContain(hex('Hello world'));
  });

  it('rejects an unencodable character with unencodable-text', async () => {
    const { bytes, size } = await onePagePdfWithText('Hello world');
    const streams = await getPageContentStreams(bytes, 0);
    const run = parseContentStreams(streams).find((r) => r.op === 'Tj')!;

    const promise = commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: run.x, y: run.y, op: 'Tj' },
      newText: '日本語',
      style: { fontFamilyHint: 'Helvetica', fontSize: size, color: { r: 0, g: 0, b: 0 } },
    });
    await expect(promise).rejects.toBeInstanceOf(TexteditError);
    await expect(promise).rejects.toMatchObject({ code: 'unencodable-text' });
  });

  it('rejects a target that matches no run with run-not-found', async () => {
    const { bytes } = await onePagePdfWithText('Hello world');
    const promise = commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: 9999, y: 9999, op: 'Tj' },
      newText: 'X',
      style: { fontFamilyHint: 'Helvetica', fontSize: 12, color: { r: 0, g: 0, b: 0 } },
    });
    await expect(promise).rejects.toBeInstanceOf(TexteditError);
    await expect(promise).rejects.toMatchObject({ code: 'run-not-found' });
  });

  it('rejects rotated text with run-not-editable, using blockedReason as the message', async () => {
    const { bytes } = await onePagePdfWithText('Tilted', { rotate: 30 });
    const streams = await getPageContentStreams(bytes, 0);
    const run = parseContentStreams(streams).find((r) => r.op === 'Tj')!;
    expect(run.editable).toBe(false); // sanity check before exercising commitTextEdit

    const promise = commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: run.x, y: run.y, op: 'Tj' },
      newText: 'X',
      style: { fontFamilyHint: 'Helvetica', fontSize: 14, color: { r: 0, g: 0, b: 0 } },
    });
    await expect(promise).rejects.toBeInstanceOf(TexteditError);
    await expect(promise).rejects.toMatchObject({
      code: 'run-not-editable',
      message: run.blockedReason,
    });
  });
});

/**
 * A PDF with two levels of Form XObject nesting and a shared parent: every
 * page's own content stream Do-invokes a parent form (registered as Fm1),
 * whose own content stream in turn Do-invokes a child form (registered as
 * Fm2 in the parent's own /Resources) that actually shows formText. The
 * parent is Do-invoked by every page from the identical underlying stream
 * object, the same way Fm1 is shared in pdfWithForm above, so this is what
 * exercises walking the whole ownership chain in commitTextEdit rather than
 * stopping at the edited form's immediate parent.
 */
async function pdfWithNestedForm(opts: {
  pageCount: number;
  formText: string;
}): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const encoder = new TextEncoder();

  const childBytes = encoder.encode(`BT /F1 18 Tf 0 0 Td (${opts.formText}) Tj ET`);
  const childDict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 300, 200],
    Resources: { Font: { F1: font.ref } },
  });
  const childRef = doc.context.register(PDFRawStream.of(childDict, childBytes));

  const parentBytes = encoder.encode('/Fm2 Do');
  const parentDict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 300, 200],
    Resources: { XObject: { Fm2: childRef } },
  });
  const parentRef = doc.context.register(PDFRawStream.of(parentDict, parentBytes));

  for (let i = 0; i < opts.pageCount; i++) {
    const page = doc.addPage([595, 842]);
    page.node.setXObject(PDFName.of('Fm1'), parentRef);
    const contentRef = doc.context.register(
      PDFRawStream.of(doc.context.obj({}), encoder.encode('/Fm1 Do')),
    );
    page.node.set(PDFName.of('Contents'), contentRef);
  }

  return { bytes: await doc.save() };
}

/**
 * Decode the content stream reached by resolving parentName against the
 * page's own Resources, then childName against *that* form's own Resources
 * in turn. A whole-file text scan cannot tell the nested test below anything
 * useful: the original child stream is left behind, orphaned, once nothing
 * points at it any more, so it would still be found by scanning every byte
 * in the file. Only walking the live chain like this proves what a page
 * actually resolves to.
 */
async function nestedFormContentOnPage(
  bytes: Uint8Array,
  pageIndex: number,
  parentName: string,
  childName: string,
): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);

  const pageXObject = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const parentStream = doc.context.lookup(pageXObject?.get(PDFName.of(parentName)), PDFStream);

  const parentXObject = parentStream.dict
    .lookupMaybe(PDFName.of('Resources'), PDFDict)
    ?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const childStream = doc.context.lookup(parentXObject?.get(PDFName.of(childName)), PDFStream);

  const decoded =
    childStream instanceof PDFRawStream
      ? decodePDFRawStream(childStream).decode()
      : childStream.getContents();
  return latin1(decoded);
}

describe('commitTextEdit (text inside a Form XObject)', () => {
  it('replaces text located inside a Do-invoked form, and leaves a second page sharing the same XObject unchanged', async () => {
    // Matrix translates by (20, 30); the form's own Td adds (10, 5) on top of
    // that, so the run's origin in page space is (30, 35) (fontSize is
    // unscaled: the Matrix has no scaling component).
    const { bytes } = await pdfWithForm({
      pageCount: 2,
      formText: 'Hello world',
      matrix: [1, 0, 0, 1, 20, 30],
      formTd: [10, 5],
    });

    // Both pages start out invoking the same, untouched form.
    expect(await formContentOnPage(bytes, 0, 'Fm1')).toContain('Hello world');
    expect(await formContentOnPage(bytes, 1, 'Fm1')).toContain('Hello world');
    // The text lives inside the form, not inline in the page's own content.
    const page0Before = await getPageContentStreams(bytes, 0);
    expect(page0Before.map(latin1).join('\n')).not.toContain('Hello world');

    const result = await commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: 30, y: 35, op: 'Tj' },
      newText: 'Goodbye',
      style: { fontFamilyHint: 'Helvetica', fontSize: 18, color: { r: 0, g: 0, b: 0 } },
    });

    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);

    // Page 0 (the page the edit targeted): its own copy of the form has the
    // original text spliced out, and the replacement is drawn on the page.
    // drawText hex-encodes the string it is given (see the existing
    // commitTextEdit tests above), hence comparing against hex('Goodbye')
    // rather than the literal text.
    expect(await formContentOnPage(result, 0, 'Fm1')).not.toContain('Hello world');
    const page0After = await getPageContentStreams(result, 0);
    expect(page0After.map(latin1).join('\n').toUpperCase()).toContain(hex('Goodbye'));

    // Page 1: still invokes the ORIGINAL, unedited form. This is the
    // sharing-safety guarantee: editing page 0 must not touch bytes page 1
    // (or any other invocation of the same XObject) is still looking at.
    expect(await formContentOnPage(result, 1, 'Fm1')).toContain('Hello world');
    expect(await formContentOnPage(result, 1, 'Fm1')).not.toContain('Goodbye');
  });

  it('rejects an edit with run-in-shared-xobject when the same Form XObject is invoked more than once on one page', async () => {
    const { bytes } = await pdfWithForm({
      pageCount: 1,
      formText: 'Stamp',
      invocationsOnPage0: 2,
    });

    const promise = commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: 0, y: 0, op: 'Tj' },
      newText: 'X',
      style: { fontFamilyHint: 'Helvetica', fontSize: 18, color: { r: 0, g: 0, b: 0 } },
    });
    await expect(promise).rejects.toBeInstanceOf(TexteditError);
    await expect(promise).rejects.toMatchObject({
      code: 'run-in-shared-xobject',
      message: 'This text is part of a template used more than once on the page',
    });
  });

  it('replaces text nested two forms deep without corrupting a shared parent on another page', async () => {
    const { bytes } = await pdfWithNestedForm({ pageCount: 2, formText: 'EDITME' });

    // Both pages start out resolving the same chain (page -> Fm1 -> Fm2) to
    // the same, untouched child content.
    expect(await nestedFormContentOnPage(bytes, 0, 'Fm1', 'Fm2')).toContain('EDITME');
    expect(await nestedFormContentOnPage(bytes, 1, 'Fm1', 'Fm2')).toContain('EDITME');

    const result = await commitTextEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { x: 0, y: 0, op: 'Tj' },
      newText: 'Replaced',
      style: { fontFamilyHint: 'Helvetica', fontSize: 18, color: { r: 0, g: 0, b: 0 } },
    });

    const resultDoc = await PDFDocument.load(result);
    expect(resultDoc.getPageCount()).toBe(2);

    // Page 0 (the page the edit targeted): the chain now resolves, at both
    // levels, to fresh copies with the original text spliced out of the
    // child, and the replacement is drawn on the page itself (same as the
    // single-level test above).
    expect(await nestedFormContentOnPage(result, 0, 'Fm1', 'Fm2')).not.toContain('EDITME');
    const page0After = await getPageContentStreams(result, 0);
    expect(page0After.map(latin1).join('\n').toUpperCase()).toContain(hex('Replaced'));

    // Page 1: never targeted by the edit, so its chain must still resolve,
    // top to bottom, to the ORIGINAL parent and the original child. Fm1 is
    // Do-invoked from both pages via the same underlying stream object, so
    // replacing only the child and writing the redirect into that shared
    // parent's /Resources in place (the pre-fix behavior) would make this
    // assertion fail: page 1 would resolve to the same mutated parent and
    // therefore the same edited child. Walking the whole chain up to the
    // page (see the parentStreamId loop in commitTextEdit) is what keeps
    // page 1 pointed at an untouched parent instead.
    expect(await nestedFormContentOnPage(result, 1, 'Fm1', 'Fm2')).toContain('EDITME');
    expect(await nestedFormContentOnPage(result, 1, 'Fm1', 'Fm2')).not.toContain('Replaced');
  });
});
