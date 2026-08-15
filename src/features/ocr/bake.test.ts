// @vitest-environment node
import zlib from 'node:zlib';

import { degrees, PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { stampOcrLayer } from './bake';
import type { OcrPage } from './types';

/** Inflate all FlateDecode streams so we can read the drawn (compressed) text. */
function decodedStreams(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const stream = Buffer.from('stream');
  const endstream = Buffer.from('endstream');
  let out = '';
  let idx = 0;
  for (;;) {
    const s = buf.indexOf(stream, idx);
    if (s === -1) break;
    let start = s + stream.length;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf(endstream, start);
    if (e === -1) break;
    let end = e;
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    const chunk = buf.subarray(start, end);
    try {
      out += zlib.inflateSync(chunk).toString('latin1');
    } catch {
      out += chunk.toString('latin1');
    }
    idx = e + endstream.length;
  }
  return out;
}

const hex = (s: string) =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return doc.save();
}

describe('stampOcrLayer', () => {
  it('draws the recognized words so the text is extractable/searchable', async () => {
    const ocrPage: OcrPage = {
      pageNumber: 1,
      text: 'HELLO WORLD',
      words: [
        { text: 'HELLO', rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.03 } },
        { text: 'WORLD', rect: { x: 0.35, y: 0.1, width: 0.2, height: 0.03 } },
      ],
    };
    const pdf = await PDFDocument.load(await onePagePdf());
    await stampOcrLayer(pdf, [ocrPage]);
    const out = await pdf.save();

    const decoded = decodedStreams(out).toUpperCase();
    expect(decoded).toContain(hex('HELLO'));
    expect(decoded).toContain(hex('WORLD'));
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });

  it('skips words the standard font cannot encode without failing', async () => {
    const ocrPage: OcrPage = {
      pageNumber: 1,
      text: '',
      words: [
        { text: '你好', rect: { x: 0.1, y: 0.2, width: 0.2, height: 0.03 } }, // non-Latin
        { text: 'OKAY', rect: { x: 0.4, y: 0.2, width: 0.2, height: 0.03 } },
      ],
    };
    const pdf = await PDFDocument.load(await onePagePdf());
    await expect(stampOcrLayer(pdf, [ocrPage])).resolves.toBeUndefined();
    const decoded = decodedStreams(await pdf.save()).toUpperCase();
    expect(decoded).toContain(hex('OKAY'));
  });

  it('is a no-op for an empty page list', async () => {
    const pdf = await PDFDocument.load(await onePagePdf());
    await expect(stampOcrLayer(pdf, [])).resolves.toBeUndefined();
  });

  it('places a word where the user saw it on a 90°-rotated page', async () => {
    // Same fixture pageGeometry.test.ts checks placeRect/offsetInFrame
    // against: a 400x600 MediaBox turned 90 degrees (displayed as 600x400),
    // and a word box a quarter in from the left, half way down, half the
    // displayed width, a quarter of the displayed height. placeRect resolves
    // that to {x: 300, y: 150, width: 300, height: 100, rotate: degrees(90)}.
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    page.setRotation(degrees(90));
    const ocrPage: OcrPage = {
      pageNumber: 1,
      text: 'HELLO',
      words: [{ text: 'HELLO', rect: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } }],
    };

    const drawText = vi.spyOn(page, 'drawText');
    await stampOcrLayer(doc, [ocrPage]);

    // size = max(4, height*0.9) = 90. The baseline sits height*0.15 = 15
    // above the box's bottom edge, along the placement's own axes: on this
    // turn that is 15 in negative user-x from the anchor (see
    // offsetInFrame's 90-degree case), landing at x=300-15=285, y=150.
    expect(drawText).toHaveBeenCalledWith(
      'HELLO',
      expect.objectContaining({ x: 285, y: 150, size: 90, rotate: degrees(90) }),
    );
  });
});
