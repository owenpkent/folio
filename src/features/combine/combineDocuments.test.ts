import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { combinePdfs, countPdfPages } from './combineDocuments';

/** A tiny PDF with one page per size given, so pages from different inputs
 * are distinguishable by width after merging. */
async function pdfBytes(pageSizes: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const size of pageSizes) doc.addPage([size, size]);
  return doc.save();
}

/** Bytes that pass the `%PDF-` / length gate but are not a real PDF
 * structure, so pdf-lib's own parser (not the plausibility check) rejects
 * them -- standing in for a corrupt or encrypted file. */
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

    const out = await combinePdfs([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
      { name: 'c.pdf', bytes: c },
    ]);

    const merged = await PDFDocument.load(out);
    expect(merged.getPageCount()).toBe(6);
    expect(merged.getPages().map((p) => p.getWidth())).toEqual([100, 100, 200, 300, 300, 300]);
  });

  it('sets a title on the combined document', async () => {
    const a = await pdfBytes([100]);
    const b = await pdfBytes([100]);

    const out = await combinePdfs([
      { name: 'a.pdf', bytes: a },
      { name: 'b.pdf', bytes: b },
    ]);

    expect((await PDFDocument.load(out)).getTitle()).toBe('Combined document');
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

  it('accepts a PDF with junk before the %PDF- header (spec allows 1024 bytes)', async () => {
    const clean = await pdfBytes([100]);
    const junk = new TextEncoder().encode('x'.repeat(512));
    const prefixed = new Uint8Array(junk.length + clean.length);
    prefixed.set(junk, 0);
    prefixed.set(clean, junk.length);

    const out = await combinePdfs([
      { name: 'clean.pdf', bytes: clean },
      { name: 'prefixed.pdf', bytes: prefixed },
    ]);

    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it('rejects fewer than two inputs', async () => {
    const only = await pdfBytes([100]);

    await expect(combinePdfs([{ name: 'only.pdf', bytes: only }])).rejects.toThrow();
    await expect(combinePdfs([])).rejects.toThrow();
  });
});

describe('countPdfPages', () => {
  it('reads the page count of a valid PDF', async () => {
    const bytes = await pdfBytes([100, 100, 100]);
    await expect(countPdfPages(bytes, 'x.pdf')).resolves.toBe(3);
  });

  it('rejects an unreadable file, naming it', async () => {
    await expect(countPdfPages(new Uint8Array([1, 2, 3]), 'tiny.pdf')).rejects.toThrow(/tiny\.pdf/);
    await expect(countPdfPages(corruptButPlausible(), 'broken.pdf')).rejects.toThrow(/broken\.pdf/);
  });
});
