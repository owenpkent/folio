// @vitest-environment node
import zlib from 'node:zlib';

import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

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
});
