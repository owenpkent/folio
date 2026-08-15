import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import {
  CombineCancelledError,
  combinePdfs,
  MAX_COMBINE_INPUTS,
  stagePdf,
} from './combineDocuments';

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

/** A PDF with no Info dict entries at all, for checking that combining does
 * not invent a Producer of its own. `PDFDocument.create()` stamps pdf-lib as
 * the producer unless told not to, so the opt-out is needed on both ends. */
async function pdfWithoutMetadata(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([100, 100]);
  return doc.save();
}

/** A form PDF carrying the AcroForm-level settings that are not the field
 * tree: the ones a merge starting from a bare `{ Fields: [] }` silently drops. */
async function pdfWithAcroFormSettings(name: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const field = doc.getForm().createTextField(name);
  field.setText('x');
  field.addToPage(page, { x: 10, y: 10, width: 60, height: 20 });

  const acroForm = doc.catalog.getOrCreateAcroForm();
  acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
  acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(1));
  acroForm.dict.set(PDFName.of('Q'), PDFNumber.of(1));
  return doc.save();
}

/** Every widget annotation the pages carry, in page order. */
function pageWidgetRefs(doc: PDFDocument): PDFRef[] {
  const refs: PDFRef[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (const entry of annots.asArray()) {
      if (entry instanceof PDFRef) refs.push(entry);
    }
  }
  return refs;
}

/** Every top-level `/AcroForm/Fields` entry, as strings. */
function topLevelFieldRefs(doc: PDFDocument): string[] {
  const fields = doc.catalog.getAcroForm()?.dict.lookupMaybe(PDFName.of('Fields'), PDFArray);
  if (!fields) return [];
  return fields
    .asArray()
    .filter((entry): entry is PDFRef => entry instanceof PDFRef)
    .map((ref) => ref.toString());
}

/**
 * The field object a page's widget annotation belongs to. pdf-lib's
 * `addToPage` makes the widget a separate object from the field and links it
 * back with `/Parent`; a field with no separate widget is its own.
 */
function fieldOfWidget(doc: PDFDocument, widgetRef: PDFRef): { ref: string; dict: PDFDict } {
  const widget = doc.context.lookup(widgetRef, PDFDict);
  const parent = widget.get(PDFName.of('Parent'));
  if (!(parent instanceof PDFRef)) return { ref: widgetRef.toString(), dict: widget };
  return { ref: parent.toString(), dict: doc.context.lookup(parent, PDFDict) };
}

/**
 * The value a viewer would show for the first widget on `pageIndex`, reached
 * from the page rather than from the form: page -> annotation -> its field.
 */
function valueViaPageWidget(doc: PDFDocument, pageIndex: number): string | undefined {
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const widgetRef = annots?.get(0);
  if (!(widgetRef instanceof PDFRef)) return undefined;
  return fieldOfWidget(doc, widgetRef)
    .dict.lookupMaybe(PDFName.of('V'), PDFString, PDFHexString)
    ?.decodeText();
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

  it('stops when cancelled after the last page is copied, before the result is handed back', async () => {
    const a = await pdfBytes([100]);
    const b = await pdfBytes([100]);
    let cancelled = false;

    // Cancel exactly when the copy loop has finished its last input, which
    // leaves save() as the only work left. On a large merge that is the
    // longest single step, and with no checkpoint either side of it a cancel
    // arriving then was ignored outright: the caller went straight on to
    // load the result over whatever document the user was looking at.
    await expect(
      combinePdfs(
        [
          { name: 'a.pdf', bytes: a },
          { name: 'b.pdf', bytes: b },
        ],
        {
          onProgress: (done, total) => {
            if (done === total) cancelled = true;
          },
          isCancelled: () => cancelled,
        },
      ),
    ).rejects.toBeInstanceOf(CombineCancelledError);
  });

  it('refuses more inputs than one merge can hold, and says what to do instead', async () => {
    const one = await pdfBytes([100]);
    const tooMany = Array.from({ length: MAX_COMBINE_INPUTS + 1 }, (_, i) => ({
      name: `f${i}.pdf`,
      bytes: one,
    }));

    // Guard-and-explain, the way the print feature refuses a document too
    // long for one pass: nothing else bounds this, and every input is held
    // as a parsed object graph while the merged copy grows alongside them.
    await expect(combinePdfs(tooMany)).rejects.toThrow(/in batches/);
  });

  it('does not stamp pdf-lib as the producer of a merge whose first input names none', async () => {
    const a = await pdfWithoutMetadata();
    const b = await pdfWithoutMetadata();

    const result = await combinePdfs([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);

    // The `updateMetadata: false` guard was on the per-input load() calls but
    // not on the create() that builds the document actually saved, so a first
    // input with no Producer of its own left pdf-lib's signature on the
    // output -- exactly what loadInput's comment says the code prevents.
    const merged = await PDFDocument.load(result.bytes, { updateMetadata: false });
    expect(merged.getProducer()).toBeUndefined();
    expect(merged.getCreator()).toBeUndefined();
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

    it('lists in /AcroForm/Fields the same field objects the page widgets point back to', async () => {
      const a = await pdfWithTextField('Alpha', 'A');
      const b = await pdfWithTextField('Beta', 'B');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // The structural half of the desync. The copier had already copied and
      // registered each field while following its widget's /Parent, but
      // `register` never checks whether an object already has a ref, so
      // copying it again minted a second one: /Fields listed objects that no
      // widget on any page belonged to, and the field tree and the visible
      // widgets became two disconnected graphs.
      const merged = await PDFDocument.load(result.bytes);
      const fieldRefs = new Set(topLevelFieldRefs(merged));
      const widgets = pageWidgetRefs(merged);
      expect(fieldRefs.size).toBe(2);
      expect(widgets).toHaveLength(2);
      for (const widgetRef of widgets) {
        expect(fieldRefs.has(fieldOfWidget(merged, widgetRef).ref)).toBe(true);
      }
    });

    it('shows a value filled through the form API on the page the widget sits on', async () => {
      const a = await pdfWithTextField('Alpha', 'A');
      const b = await pdfWithTextField('Beta', 'B');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // The user-visible half: with the two graphs disconnected, setText
      // wrote to the orphaned copy in /Fields while the widget the viewer
      // paints still belonged to the other one, so typing into a merged form
      // field neither appeared nor persisted.
      const merged = await PDFDocument.load(result.bytes);
      merged.getForm().getTextField('Alpha').setText('FILLED');
      const reloaded = await PDFDocument.load(await merged.save());

      expect(valueViaPageWidget(reloaded, 0)).toBe('FILLED');
      expect(valueViaPageWidget(reloaded, 1)).toBe('B');
    });

    it('leaves every widget attached to a page the merged document actually has', async () => {
      const a = await pdfWithTextField('Alpha', 'A');
      const b = await pdfWithTextField('Beta', 'B');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // Copying each page by object rather than by ref put it outside the
      // copier's cache, so a widget's own /P dragged in a second, orphaned
      // copy of the page it sits on -- a page the document's own page tree
      // knew nothing about.
      const merged = await PDFDocument.load(result.bytes);
      const pageRefs = new Set(merged.getPages().map((page) => page.ref.toString()));
      for (const widgetRef of pageWidgetRefs(merged)) {
        const parentPage = merged.context.lookup(widgetRef, PDFDict).get(PDFName.of('P'));
        expect(parentPage).toBeInstanceOf(PDFRef);
        expect(pageRefs.has((parentPage as PDFRef).toString())).toBe(true);
      }
    });

    it('keeps a renamed field readable when the colliding name is not ASCII', async () => {
      const a = await pdfWithTextField('氏名', 'Alice');
      const b = await pdfWithTextField('氏名', 'Bob');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // Written as a literal PDF string, the renamed copy came back as
      // mojibake: literal strings are one byte per code unit, so every
      // character above U+00FF was truncated to 8 bits.
      const names = (await PDFDocument.load(result.bytes))
        .getForm()
        .getFields()
        .map((f) => f.getName());
      expect(names.sort()).toEqual(['氏名', '氏名 (2)']);
    });

    it('still produces a loadable PDF when the colliding name contains a delimiter', async () => {
      const a = await pdfWithTextField('a)b', 'Alice');
      const b = await pdfWithTextField('a)b', 'Bob');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // Unescaped in a literal string, the `)` closed the string early and
      // the output would not parse at all -- on the one path the renaming
      // exists for, two copies of the same form.
      const merged = await PDFDocument.load(result.bytes);
      const names = merged
        .getForm()
        .getFields()
        .map((f) => f.getName());
      expect(names.sort()).toEqual(['a)b', 'a)b (2)']);
    });

    it('carries the AcroForm settings that are not the field tree', async () => {
      const a = await pdfWithAcroFormSettings('Alpha');
      const b = await pdfWithTextField('Beta', 'B');

      const result = await combinePdfs([
        { name: 'a.pdf', bytes: a },
        { name: 'b.pdf', bytes: b },
      ]);

      // NeedAppearances is the one with visible consequences: dropping it
      // leaves fields that hold their values rendering blank, because nothing
      // downstream generates the appearance streams they were relying on.
      const merged = await PDFDocument.load(result.bytes, { updateMetadata: false });
      const acroForm = merged.catalog.getAcroForm();
      expect(acroForm?.dict.lookupMaybe(PDFName.of('NeedAppearances'), PDFBool)?.asBoolean()).toBe(
        true,
      );
      expect(acroForm?.dict.lookupMaybe(PDFName.of('SigFlags'), PDFNumber)?.asNumber()).toBe(1);
      expect(acroForm?.dict.lookupMaybe(PDFName.of('Q'), PDFNumber)?.asNumber()).toBe(1);
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
