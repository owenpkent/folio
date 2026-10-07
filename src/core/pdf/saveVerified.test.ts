// @vitest-environment node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

// The real setupWorker needs Vite's ?url import; in Node PDF.js runs its fake
// worker on its own. Everything else here is real PDF.js.
vi.mock('./setupWorker', () => {
  const require = createRequire(import.meta.url);
  return {
    ensureWorker: () => {},
    pdfWasmUrl: () =>
      pathToFileURL(join(dirname(require.resolve('pdfjs-dist/package.json')), 'wasm')).href + '/',
  };
});

import { UnsafeOutputError } from './errors';
import { reopenPageCount } from './reopenPageCount';
import { saveVerified, type PageCountVerifier } from './saveVerified';

/** Latin-1 bytes of hand-written PDF source (no xref: pdf-lib rebuilds by scanning). */
function bytesOf(source: string): Uint8Array {
  return Uint8Array.from(source, (c) => c.charCodeAt(0));
}

/** A one-page PDF whose page object is numbered `pageObjectNumber`. */
function onePagePdf(pageObjectNumber: number): Uint8Array {
  const n = pageObjectNumber;
  return bytesOf(
    '%PDF-1.4\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      `2 0 obj\n<< /Type /Pages /Kids [${n} 0 R] /Count 1 >>\nendobj\n` +
      `${n} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n` +
      `trailer\n<< /Root 1 0 R /Size ${n + 1} >>\n%%EOF\n`,
  );
}

describe('saveVerified', () => {
  it('returns the first save when it reopens with the expected pages', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const verify = vi.fn<PageCountVerifier>(async () => 1);

    const bytes = await saveVerified(pdf, 1, verify);

    expect(verify).toHaveBeenCalledTimes(1);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it('never adds a blank default page to a document with no pages', async () => {
    const pdf = await PDFDocument.create();
    const seen: number[] = [];
    await expect(
      saveVerified(pdf, 1, async (bytes) => {
        const count = (await PDFDocument.load(bytes)).getPageCount();
        seen.push(count);
        return count;
      }),
    ).rejects.toBeInstanceOf(UnsafeOutputError);
    expect(seen).toEqual([0, 0]);
  });

  it('retries once without object streams, and returns that output if it verifies', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const outputs: Uint8Array[] = [];
    const verify: PageCountVerifier = async (bytes) => {
      outputs.push(bytes);
      return outputs.length === 1 ? Promise.reject(new Error('Invalid Root reference')) : 1;
    };

    const bytes = await saveVerified(pdf, 1, verify);

    expect(outputs).toHaveLength(2);
    expect(bytes).toBe(outputs[1]);
    // The fallback is the classic layout: no compressed object streams.
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/ObjStm');
  });

  it('throws UnsafeOutputError and returns nothing when both attempts fail to verify', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const verify = vi.fn<PageCountVerifier>(async () => {
      throw new Error('Invalid Root reference');
    });

    await expect(saveVerified(pdf, 1, verify)).rejects.toThrow(UnsafeOutputError);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('keeps a file with object number 2147483647 reopenable (real PDF.js)', async () => {
    // bug1980958.pdf has an object this high: pdf-lib numbers new objects above
    // the maximum, and the xref stream it writes is one PDF.js rejects.
    const pdf = await PDFDocument.load(onePagePdf(2147483647));
    expect(pdf.getPageCount()).toBe(1);
    // The premise: the plain save really is unreadable, so passing below means
    // the fallback did the work.
    await expect(reopenPageCount(await pdf.save())).rejects.toThrow();

    const bytes = await saveVerified(pdf, 1);

    expect(await reopenPageCount(bytes)).toBe(1);
  });
});
