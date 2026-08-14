import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { CombineCancelledError, combinePdfs, stagePdf } from './combineDocuments';

/** A tiny PDF with one page per size given, so pages from different inputs
 * are distinguishable by width after merging. */
async function pdfBytes(pageSizes: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of pageSizes) doc.addPage([size, size]);
  return doc.save();
}

/** A PDF with one fillable text field, at `name` (a dotted name creates a
 * non-terminal group field as its parent -- see the nested-field test). */
async function pdfWithTextField(name: string, value: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const field = doc.getForm().createTextField(name);
  field.setText(value);
  field.addToPage(page, { x: 10, y: 10, width: 60, height: 20 });
  return doc.save();
}

/**
 * Same as {@link pdfWithTextField}, but with an extra `/DR` key forced onto
 * the AcroForm so that combining two of these is guaranteed to collide on
 * it. Empirically, pdf-lib's own default-font registration (what addToPage
 * uses when no font is given) does not collide across two independently
 * built documents, so the formsDegraded test forces the case deliberately
 * rather than relying on that.
 */
async function pdfWithTextFieldAndDrCollision(name: string, value: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const field = doc.getForm().createTextField(name);
  field.setText(value);
  field.addToPage(page, { x: 10, y: 10, width: 60, height: 20 });

  const acroForm = doc.catalog.getOrCreateAcroForm();
  const dr = acroForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict) ?? doc.context.obj({});
  dr.set(PDFName.of('Marker'), PDFName.of('shared'));
  acroForm.dict.set(PDFName.of('DR'), dr);

  return doc.save();
}

/**
 * A PDF whose trailer carries a real `/Encrypt` entry, read the same way
 * pdf-lib's own `EncryptedPDFError` guard reads it
 * (`context.lookup(context.trailerInfo.Encrypt)`, see
 * `PDFDocument` in pdf-lib), so this reproduces the actual condition
 * `combinePdfs` has to detect and explain -- not just a file that merely
 * looks encrypted. pdf-lib cannot itself write encrypted output, so the
 * entry is set by hand on a document it otherwise builds normally.
 */
async function encryptedPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  // An indirect reference, not a direct dict: every real encrypted PDF's
  // trailer /Encrypt is one, and pdf-lib's own writer special-cases it by
  // identity (`ref === trailerInfo.Encrypt`) when deciding what not to
  // compress, so a bare direct dict does not round-trip the same way.
  const encryptRef = doc.context.register(
    doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -44 }),
  );
  doc.context.trailerInfo.Encrypt = encryptRef;
  return doc.save();
}

/** Bytes that pass the `%PDF-` / length gate but are not a real PDF
 * structure, so pdf-lib's own parser (not the plausibility check) rejects
 * them -- standing in for a generically corrupt file. */
function corruptButPlausible(): Uint8Array {
  const bytes = new Uint8Array(300);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
  return bytes;
}

describe('combinePdfs', () => {
  it('combines pages from each input, in input order', async () => {
    const a = await pdfBytes([100, 100]);
    const b = await pdfBytes([200]);
    const c = await pdfBytes([300, 300, 300]);

    const result = await combinePdfs([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
      { name: 'c.pdf', bytes: c },
    ]);

    const merged = await PDFDocument.load(result.bytes);
    expect(merged.getPageCount()).toBe(6);
    expect(merged.getPages().map((p) => p.getWidth())).toEqual([100, 100, 200, 300, 300, 300]);
    expect(result.formsMerged).toBe(false);
    expect(result.formsDegraded).toBe(false);
  });

  it('sets a title on the combined document when the first input has none', async () => {
    const a = await pdfBytes([100]);
    const b = await pdfBytes([100]);

    const result = await combinePdfs([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);

    expect((await PDFDocument.load(result.bytes)).getTitle()).toBe('Combined document');
  });

  it('carries metadata forward from the first input rather than hardcoding it', async () => {
    const a = await PDFDocument.create();
    a.addPage([100, 100]);
    a.setTitle('Quarterly Report');
    a.setAuthor('Alice');
    a.setSubject('Q3 numbers');
    a.setKeywords(['finance', 'q3']);
    a.setCreator('Acme Writer');
    a.setProducer('Acme PDF Engine');
    const aBytes = await a.save();

    const b = await PDFDocument.create();
    b.addPage([100, 100]);
    b.setTitle('Second Input');
    b.setAuthor('Bob');
    const bBytes = await b.save();

    const result = await combinePdfs([
      { name: 'a.pdf', bytes: aBytes },
      { name: 'b.pdf', bytes: bBytes },
    ]);

    // updateMetadata: false here too: loading the merged bytes back with
    // pdf-lib's default options would itself stamp a fresh Producer over
    // whatever combinePdfs wrote, defeating the very thing this test checks.
    const merged = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(merged.getTitle()).toBe('Quarterly Report');
    expect(merged.getAuthor()).toBe('Alice');
    expect(merged.getSubject()).toBe('Q3 numbers');
    expect(merged.getKeywords()).toBe('finance q3');
    expect(merged.getCreator()).toBe('Acme Writer');
    expect(merged.getProducer()).toBe('Acme PDF Engine');
  });

  it('rejects a file too small to be a PDF, naming it', async () => {
    const good = await pdfBytes([100]);

    await expect(
      combinePdfs([
        { name: 'good.pdf', bytes: good },
        { name: 'tiny.pdf', bytes: new Uint8Array([1, 2, 3, 4]) },
      ]),
    ).rejects.toThrow(/tiny\.pdf/);
  });

  it('rejects a corrupt/unparseable file, naming it', async () => {
    const good = await pdfBytes([100]);

    await expect(
      combinePdfs([
        { name: 'good.pdf', bytes: good },
        { name: 'broken.pdf', bytes: corruptButPlausible() },
      ]),
    ).rejects.toThrow(/broken\.pdf/);
  });

  it('reports a password-protected input in plain language, naming it', async () => {
    const good = await pdfBytes([100]);
    const locked = await encryptedPdfBytes();

    let error: unknown;
    try {
      await combinePdfs([
        { name: 'good.pdf', bytes: good },
        { name: 'locked.pdf', bytes: locked },
      ]);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/locked\.pdf/);
    expect(message).toMatch(/password-protected/);
    // Not pdf-lib's raw EncryptedPDFError text leaking through verbatim.
    expect(message).not.toMatch(/ignoreEncryption/);
  });

  it('accepts a PDF with junk before the %PDF- header (spec allows 1024 bytes)', async () => {
    const clean = await pdfBytes([100]);
    const junk = new TextEncoder().encode('x'.repeat(512));
    const prefixed = new Uint8Array(junk.length + clean.length);
    prefixed.set(junk, 0);
    prefixed.set(clean, junk.length);

    const result = await combinePdfs([
      { name: 'clean.pdf', bytes: clean },
      { name: 'prefixed.pdf', bytes: prefixed },
    ]);

    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(2);
  });

  it('rejects fewer than two inputs', async () => {
    const only = await pdfBytes([100]);

    await expect(combinePdfs([{ name: 'only.pdf', bytes: only }])).rejects.toThrow();
    await expect(combinePdfs([])).rejects.toThrow();
  });

  it('stops with CombineCancelledError once isCancelled reports true, without throwing a generic error', async () => {
    const a = await pdfBytes([100]);
    const b = await pdfBytes([100]);

    await expect(
      combinePdfs(
        [
          { name: 'a.pdf', bytes: a },
          { name: 'b.pdf', bytes: b },
        ],
        { isCancelled: () => true },
      ),
    ).rejects.toBeInstanceOf(CombineCancelledError);
  });

  it('reports progress once per input, ending at the total', async () => {
    const a = await pdfBytes([100]);
    const b = await pdfBytes([100]);
    const c = await pdfBytes([100]);
    const calls: Array<[number, number]> = [];

    await combinePdfs(
      [
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
        { name: 'c.pdf', bytes: c },
      ],
      { onProgress: (done, total) => calls.push([done, total]) },
    );

    expect(calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  describe('AcroForm fields', () => {
    it('preserves form fields from every input instead of stripping them', async () => {
      const a = await pdfWithTextField('Name', 'Alice');
      const b = await pdfWithTextField('Email', 'alice@example.com');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      expect(result.formsMerged).toBe(true);
      const merged = await PDFDocument.load(result.bytes);
      const form = merged.getForm();
      // The bug this guards: pdf-lib's copyPages carries the page-level
      // widget annotations but never the catalog's /AcroForm, so before this
      // was merged deliberately, getFields() came back empty here even
      // though a widget was still visibly sitting on the page.
      expect(
        form
          .getFields()
          .map((f) => f.getName())
          .sort(),
      ).toEqual(['Email', 'Name']);
      expect(form.getTextField('Name').getText()).toBe('Alice');
      expect(form.getTextField('Email').getText()).toBe('alice@example.com');
    });

    it('disambiguates a field name that collides across inputs instead of silently fusing them', async () => {
      const a = await pdfWithTextField('Name', 'Alice');
      const b = await pdfWithTextField('Name', 'Bob');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      const merged = await PDFDocument.load(result.bytes);
      const names = merged
        .getForm()
        .getFields()
        .map((f) => f.getName());
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      expect(names).toContain('Name');
    });

    it('reports formsDegraded when merging cannot reconcile the /DR resources of two inputs', async () => {
      const a = await pdfWithTextFieldAndDrCollision('Name', 'Alice');
      const b = await pdfWithTextFieldAndDrCollision('Email', 'Bob');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // Both fields still merged in, with their values intact -- degraded
      // means the merge lost a resource mapping, not that it failed.
      expect(result.formsMerged).toBe(true);
      expect(result.formsDegraded).toBe(true);
      const merged = await PDFDocument.load(result.bytes);
      const form = merged.getForm();
      expect(form.getTextField('Name').getText()).toBe('Alice');
      expect(form.getTextField('Email').getText()).toBe('Bob');
    });

    it('does not report formsDegraded when only one input has form fields', async () => {
      const a = await pdfWithTextField('Name', 'Alice');
      const b = await pdfBytes([100]);

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      expect(result.formsMerged).toBe(true);
      expect(result.formsDegraded).toBe(false);
    });

    it('does not duplicate a field nested under a non-terminal group field', async () => {
      // A dotted name makes pdf-lib create a genuine non-terminal parent
      // field ("Group") with this as its terminal child -- the shape that
      // exposed the regression: merging by iterating the flattened field
      // list (parents AND every nested child as separate entries) added the
      // nested child to the merged document's /Fields a second time, once on
      // its own and once already nested inside its copied parent.
      const a = await pdfWithTextField('Group.Name', 'Alice');
      const b = await pdfBytes([100]);

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      const merged = await PDFDocument.load(result.bytes);
      const names = merged
        .getForm()
        .getFields()
        .map((f) => f.getName());
      expect(names.filter((n) => n === 'Group.Name')).toHaveLength(1);
      expect(merged.getForm().getTextField('Group.Name').getText()).toBe('Alice');
    });

    it('does not set formsMerged when no input has form fields', async () => {
      const a = await pdfBytes([100]);
      const b = await pdfBytes([100]);

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      expect(result.formsMerged).toBe(false);
      expect(result.formsDegraded).toBe(false);
    });
  });
});

describe('stagePdf', () => {
  it('reads the page count of a valid PDF', async () => {
    const bytes = await pdfBytes([100, 100, 100]);
    const staged = await stagePdf(bytes, 'x.pdf');
    expect(staged.pageCount).toBe(3);
    expect(staged.doc.getPageCount()).toBe(3);
  });

  it('rejects an unreadable file, naming it', async () => {
    await expect(stagePdf(new Uint8Array([1, 2, 3]), 'tiny.pdf')).rejects.toThrow(/tiny\.pdf/);
    await expect(stagePdf(corruptButPlausible(), 'broken.pdf')).rejects.toThrow(/broken\.pdf/);
  });

  it('reports a password-protected file in plain language', async () => {
    const locked = await encryptedPdfBytes();
    let error: unknown;
    try {
      await stagePdf(locked, 'locked.pdf');
    } catch (e) {
      error = e;
    }
    const message = (error as Error).message;
    expect(message).toMatch(/locked\.pdf/);
    expect(message).toMatch(/password-protected/);
  });
});
