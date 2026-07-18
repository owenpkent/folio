// @vitest-environment node
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
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
