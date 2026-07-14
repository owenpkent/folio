// @vitest-environment node
import zlib from 'node:zlib';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { hexToRgb01, standardFontFor, stampEdits, wrapText } from './bake';
import type { EditItem } from './types';

/**
 * Inflate every FlateDecode stream in a PDF and return the concatenated decoded
 * text. pdf-lib compresses content streams, so drawn text only appears after
 * decompression. Lets us assert what was drawn without spinning up a pdf.js worker.
 */
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
    if (buf[start] === 0x0d) start++; // CR
    if (buf[start] === 0x0a) start++; // LF
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

// A valid 1x1 transparent PNG.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]); // A4 in points
  return doc.save();
}

describe('hexToRgb01', () => {
  it('parses #rrggbb into 0..1 components', () => {
    expect(hexToRgb01('#ffffff')).toEqual({ r: 1, g: 1, b: 1 });
    expect(hexToRgb01('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb01('#ff0000')).toEqual({ r: 1, g: 0, b: 0 });
  });

  it('expands #rgb shorthand and falls back to black on junk', () => {
    expect(hexToRgb01('#f00')).toEqual({ r: 1, g: 0, b: 0 });
    expect(hexToRgb01('not-a-color')).toEqual({ r: 0, g: 0, b: 0 });
  });
});

describe('standardFontFor', () => {
  it('maps family + bold to the right StandardFont', () => {
    expect(standardFontFor('Helvetica', false)).toBe(StandardFonts.Helvetica);
    expect(standardFontFor('Helvetica', true)).toBe(StandardFonts.HelveticaBold);
    expect(standardFontFor('Times', false)).toBe(StandardFonts.TimesRoman);
    expect(standardFontFor('Times', true)).toBe(StandardFonts.TimesRomanBold);
    expect(standardFontFor('Courier', true)).toBe(StandardFonts.CourierBold);
  });
});

describe('wrapText', () => {
  it('honors existing newlines', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(wrapText('a\nb\nc', font, 12, 1000)).toEqual(['a', 'b', 'c']);
  });

  it('wraps to the given width', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const words = 'one two three four five six seven eight nine ten';
    const lines = wrapText(words, font, 24, 120);
    expect(lines.length).toBeGreaterThan(1);
    // Every wrapped line fits (a lone over-wide word is the only allowed overflow).
    for (const line of lines) {
      if (line.includes(' ')) expect(font.widthOfTextAtSize(line, 24)).toBeLessThanOrEqual(120);
    }
  });
});

describe('stampEdits', () => {
  const textEdit: EditItem = {
    id: 't1',
    kind: 'text',
    pageNumber: 1,
    rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
    text: 'FOLIOEDITTOKEN',
    fontFamily: 'Helvetica',
    bold: false,
    fontSizePt: 18,
    colorHex: '#112233',
    createdAt: 0,
  };
  const imageEdit: EditItem = {
    id: 'i1',
    kind: 'image',
    pageNumber: 1,
    rect: { x: 0.2, y: 0.5, width: 0.3, height: 0.2 },
    dataUrl: PNG_1x1,
    mime: 'image/png',
    createdAt: 0,
  };

  it('draws text into the page content stream and keeps the PDF valid', async () => {
    const pdf = await PDFDocument.load(await onePagePdf());
    await stampEdits(pdf, [textEdit]);
    const out = await pdf.save();

    // Reloads and preserves the page.
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    // pdf-lib shows text as a hex string operand (<...> Tj) in the Flate content
    // stream; assert the token's hex encoding is present.
    const hex = [...'FOLIOEDITTOKEN']
      .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    expect(decodedStreams(out).toUpperCase()).toContain(hex);
  });

  it('adds image data to the document', async () => {
    const textOnly = await PDFDocument.load(await onePagePdf());
    await stampEdits(textOnly, [textEdit]);
    const textBytes = await textOnly.save();

    const withImage = await PDFDocument.load(await onePagePdf());
    await stampEdits(withImage, [textEdit, imageEdit]);
    const imageBytes = await withImage.save();

    expect(imageBytes.length).toBeGreaterThan(textBytes.length);
    expect((await PDFDocument.load(imageBytes)).getPageCount()).toBe(1);
  });

  it('skips empty text and out-of-range pages without throwing', async () => {
    const pdf = await PDFDocument.load(await onePagePdf());
    await stampEdits(pdf, [
      { ...textEdit, id: 'blank', text: '   ' },
      { ...textEdit, id: 'offpage', pageNumber: 99 },
    ]);
    expect((await pdf.save()).length).toBeGreaterThan(0);
  });
});
