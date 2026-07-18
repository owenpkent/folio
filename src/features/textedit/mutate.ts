/**
 * pdf-lib side of in-place text editing: locate the target run inside the
 * current PDF bytes, splice its show-text operator out of the content
 * stream, and (unless the replacement is empty) draw new text at the same
 * baseline origin. See features/textedit/types.ts for the overall pipeline
 * and contentStream.ts for the tokenizer/interpreter this builds on.
 */

import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
  type PDFPage,
} from 'pdf-lib';

import { matchRunToItem, parseContentStreams, spliceRun } from './contentStream';
import type { CommitEditParams, TexteditErrorCode } from './types';

export class TexteditError extends Error {
  readonly code: TexteditErrorCode;

  constructor(code: TexteditErrorCode, message: string) {
    super(message);
    this.name = 'TexteditError';
    this.code = code;
  }
}

function resolvePage(doc: PDFDocument, pageIndex: number): PDFPage {
  const pages = doc.getPages();
  const page = pages[pageIndex];
  if (pageIndex < 0 || !page) {
    throw new TexteditError(
      'page-out-of-range',
      `Page ${pageIndex} is out of range (document has ${pages.length} pages)`,
    );
  }
  return page;
}

/**
 * Every content stream read back from an existing (loaded) PDF is a
 * PDFRawStream: raw bytes plus an optional /Filter. decodePDFRawStream is the
 * identity transform when there is no filter, so this handles filtered and
 * unfiltered streams the same way. The generic PDFStream fallback is
 * defensive; pdf-lib's parser does not produce any other stream kind here.
 */
function decodeContentStream(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  return stream.getContents();
}

/** Decode a page's content stream(s) in order. A page with no Contents yields []. */
function decodePageContentStreams(page: PDFPage): Uint8Array[] {
  const contents = page.node.Contents();
  if (!contents) return [];
  if (contents instanceof PDFArray) {
    const streams: Uint8Array[] = [];
    for (let i = 0; i < contents.size(); i++) {
      streams.push(decodeContentStream(contents.lookup(i, PDFStream)));
    }
    return streams;
  }
  return [decodeContentStream(contents)];
}

export async function getPageContentStreams(
  pdfBytes: Uint8Array,
  pageIndex: number,
): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);
  return decodePageContentStreams(page);
}

/** Concatenate decoded streams into one buffer, joined by a newline byte. */
function mergeStreams(streams: Uint8Array[]): Uint8Array {
  const separators = Math.max(streams.length - 1, 0);
  const out = new Uint8Array(streams.reduce((sum, s) => sum + s.length, 0) + separators);
  let offset = 0;
  streams.forEach((bytes, i) => {
    if (i > 0) out[offset++] = 0x0a;
    out.set(bytes, offset);
    offset += bytes.length;
  });
  return out;
}

/**
 * Map a CommitStyle.fontFamilyHint (a CSS-ish family string from PDF.js) to a
 * pdf-lib standard font. Only WinAnsi/Latin standard fonts are supported.
 */
function standardFontFor(hint: string): StandardFonts {
  const h = hint.toLowerCase();
  const bold = h.includes('bold');
  const italic = h.includes('italic') || h.includes('oblique');

  if ((h.includes('times') || h.includes('serif')) && !h.includes('sans')) {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (h.includes('courier') || h.includes('mono')) {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

export async function commitTextEdit(params: CommitEditParams): Promise<Uint8Array> {
  const { pdfBytes, pageIndex, target, newText, style } = params;
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);

  const streams = decodePageContentStreams(page);
  const runs = parseContentStreams(streams);
  const run = matchRunToItem(runs, target, { op: target.op });
  if (!run) {
    throw new TexteditError('run-not-found', 'Could not find that text in the page content');
  }
  if (!run.editable) {
    throw new TexteditError('run-not-editable', run.blockedReason ?? 'This text cannot be edited');
  }

  const spliced = streams.map((bytes, i) =>
    i === run.streamIndex ? spliceRun(bytes, run) : bytes,
  );
  const mergedRef = doc.context.register(
    PDFRawStream.of(doc.context.obj({}), mergeStreams(spliced)),
  );
  page.node.set(PDFName.of('Contents'), mergedRef);

  if (newText.length > 0) {
    const font = await doc.embedFont(standardFontFor(style.fontFamilyHint));
    try {
      // run.x/run.y are the baseline origin after Tm and CTM (LocatedRun's
      // "device space", i.e. PDF user space after the content stream's own
      // graphics state); drawText's x/y are plain page user space. These
      // coincide exactly when the run's CTM is identity or a pure
      // translation/uniform-scale, because such a matrix only shifts and
      // scales the origin, it does not change which space it is measured
      // in, and fontSize was scaled by that same matrix above. Rotated or
      // skewed CTMs would break this, but parseContentStreams already
      // marks those runs not editable, so they never reach here.
      page.drawText(newText, {
        x: run.x,
        y: run.y,
        size: style.fontSize,
        font,
        color: rgb(style.color.r, style.color.g, style.color.b),
      });
    } catch (error) {
      if (error instanceof Error && /cannot encode/i.test(error.message)) {
        throw new TexteditError(
          'unencodable-text',
          'Some characters are not supported by built-in fonts yet',
        );
      }
      throw error;
    }
  }

  return doc.save();
}
