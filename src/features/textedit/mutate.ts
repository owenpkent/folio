/**
 * pdf-lib side of in-place text editing: locate the target run inside the
 * current PDF bytes, splice its show-text operator out of the content
 * stream, and (unless the replacement is empty) show the new text in the
 * same spot of the stream, so it keeps the original's painting order. See features/textedit/types.ts for the overall pipeline
 * and contentStream.ts for the tokenizer/interpreter this builds on.
 *
 * Text located inside a Do-invoked Form XObject is spliced out of a *new*
 * copy of that form's stream, never the original: the same form can be
 * Do-invoked from other pages, or more than once from this one, and pdf-lib
 * exposes no refcount to say whether that is the case. buildFormResolver
 * below is where that bookkeeping lives.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  StandardFonts,
  decodePDFRawStream,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

import { matchRunToItem, parseContentStreams, spliceRun, type FormResolver } from './contentStream';
import type { CommitEditParams, LocatedRun, TexteditErrorCode } from './types';

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

/**
 * Everything commitTextEdit needs to remember about one resolved Form XObject
 * in order to splice a replacement back in later without disturbing the
 * original (see this file's header). Recorded the first time
 * buildFormResolver resolves a given form. Exported for features/imageedit,
 * which resolves Do names against the object model too (to tell an Image
 * XObject from a form) but has no reason to duplicate this bookkeeping.
 */
export interface FormEntry {
  /** The form's own stream dictionary: Type, Subtype, BBox, Matrix, Resources, ... */
  dict: PDFDict;
  bytes: Uint8Array;
  matrix?: [number, number, number, number, number, number];
  /**
   * The Resources dict active where this form was invoked from (the page's
   * own Resources for a page-invoked form, or the parent form's own
   * /Resources for a nested one), and that dict's /XObject subdictionary.
   * Cloning both, then redirecting `name` in the cloned /XObject to a new
   * stream, is how an edit reattaches a replacement without mutating
   * anything another page (or another invocation on this one) might also be
   * looking at; see commitTextEdit.
   */
  resourcesDict: PDFDict;
  xobjectDict: PDFDict;
  /**
   * The form this one was Do-invoked from, or undefined when the page's own
   * content stream invoked it. commitTextEdit walks this back up to the page
   * so every form on the chain is replaced rather than edited in place; a
   * parent can be shared just as readily as the form holding the edit.
   * Unambiguous for any editable run: the parser blocks runs inside a form it
   * resolved more than once, so an edit can only ever reach a form with a
   * single invocation, hence a single parent.
   */
  parentStreamId?: number;
  /** This form's key within xobjectDict. */
  name: string;
}

/** Read a stream dict's /Matrix. Anything absent or malformed reads as undefined (identity). */
function readMatrix(dict: PDFDict): [number, number, number, number, number, number] | undefined {
  const array = dict.lookupMaybe(PDFName.of('Matrix'), PDFArray);
  if (!array || array.size() !== 6) return undefined;
  const values: number[] = [];
  for (let i = 0; i < 6; i++) {
    const n = array.lookupMaybe(i, PDFNumber);
    if (!n) return undefined;
    values.push(n.asNumber());
  }
  return values as [number, number, number, number, number, number];
}

/**
 * Copy a stream's dictionary for a rewritten copy of that stream, dropping
 * /Filter and /Length. The replacement bytes are uncompressed and a different
 * length, so both entries would be stale, and pdf-lib recomputes /Length when
 * it serializes a stream whether or not the dict already carries one.
 */
function copyStreamDict(doc: PDFDocument, dict: PDFDict): PDFDict {
  const copy = doc.context.obj({});
  for (const [key, value] of dict.entries()) {
    if (key === PDFName.of('Filter') || key === PDFName.of('Length')) continue;
    copy.set(key, value);
  }
  return copy;
}

/**
 * The Resources dict governing Do names invoked from `streamIndex`: the
 * page's own Resources for one of its own content streams (index below
 * `streamCount`), or the resolved form's own `/Resources` for a form (see
 * FormEntry). Shared by buildFormResolver's own name lookup below and by
 * features/imageedit, which resolves Do names against the object model too
 * (to tell an Image XObject from anything else) but has no FormResolver
 * machinery of its own to reach a form's Resources.
 */
export function resourcesForStream(
  streamIndex: number,
  streamCount: number,
  pageResources: PDFDict | undefined,
  forms: Map<number, FormEntry>,
): PDFDict | undefined {
  return streamIndex < streamCount
    ? pageResources
    : forms.get(streamIndex)?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
}

/**
 * Builds the FormResolver contentStream.ts's parser uses to descend into
 * Do-invoked Form XObjects, plus the registry commitTextEdit consults
 * afterward to splice a located run back in (see FormEntry). This is the one
 * place that walks Resources/XObject dictionaries, matching this file's role
 * as the pdf-lib (object-model) side of the feature; contentStream.ts has no
 * model of its own on purpose.
 *
 * Ids 0..streamCount-1 are the page's own content streams; ids handed out
 * here start at streamCount, one each the first time a given underlying
 * stream is resolved. Repeat resolutions (the same XObject invoked again,
 * whether by the same name or a different one) reuse that id, which is what
 * lets the parser's multiply-invoked guard count them.
 */
function buildFormResolver(
  doc: PDFDocument,
  page: PDFPage,
  streamCount: number,
): { resolveForm: FormResolver; forms: Map<number, FormEntry> } {
  const forms = new Map<number, FormEntry>();
  const idByRef = new Map<string, number>();
  let nextId = streamCount;

  // Resources is a page attribute (7.7.3.4), not a per-content-stream one, so
  // every page-level streamIndex (0..streamCount-1) resolves Do names
  // against this same dict.
  const pageResources = page.node.Resources();

  const resolveForm: FormResolver = (name, fromStreamId) => {
    const invokingResources = resourcesForStream(fromStreamId, streamCount, pageResources, forms);
    if (!invokingResources) return undefined;

    const xobjectDict = invokingResources.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const ref = xobjectDict?.get(PDFName.of(name));
    if (!xobjectDict || !(ref instanceof PDFRef)) return undefined;

    // Same underlying stream (by ref) always maps to the same assigned id,
    // whether it is reached again via the same name or a different one.
    const cachedId = idByRef.get(ref.toString());
    if (cachedId !== undefined) {
      const cached = forms.get(cachedId);
      if (cached) return { streamId: cachedId, bytes: cached.bytes, matrix: cached.matrix };
    }

    const stream = doc.context.lookupMaybe(ref, PDFStream);
    if (!stream) return undefined;
    // Only a Form XObject is something this feature can descend into; an
    // Image XObject (or anything else) is left for the parser to skip, same
    // as it always has been.
    const subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (subtype !== PDFName.of('Form')) return undefined;

    const id = nextId++;
    const bytes = decodeContentStream(stream);
    const matrix = readMatrix(stream.dict);
    forms.set(id, {
      dict: stream.dict,
      bytes,
      matrix,
      resourcesDict: invokingResources,
      xobjectDict,
      parentStreamId: fromStreamId < streamCount ? undefined : fromStreamId,
      name,
    });
    idByRef.set(ref.toString(), id);
    return { streamId: id, bytes, matrix };
  };

  return { resolveForm, forms };
}

/**
 * Exported for features/imageedit, which needs the same decoded streams and
 * FormResolver to enumerate image draws (including ones inside a Do-invoked
 * form) without re-implementing any of this file's object-model walking.
 */
export interface PageContentModel {
  /** Decoded page content stream(s), in order; index is LocatedRun.streamIndex 0..n-1. */
  streams: Uint8Array[];
  resolveForm: FormResolver;
  forms: Map<number, FormEntry>;
}

/** Decode a page's content stream(s) in order. A page with no Contents yields []. */
export function decodePageContentStreams(doc: PDFDocument, page: PDFPage): PageContentModel {
  const contents = page.node.Contents();
  const streams: Uint8Array[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      streams.push(decodeContentStream(contents.lookup(i, PDFStream)));
    }
  } else if (contents) {
    streams.push(decodeContentStream(contents));
  }

  const { resolveForm, forms } = buildFormResolver(doc, page, streams.length);
  return { streams, resolveForm, forms };
}

export async function getPageContentStreams(
  pdfBytes: Uint8Array,
  pageIndex: number,
): Promise<Uint8Array[]> {
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);
  return decodePageContentStreams(doc, page).streams;
}

/**
 * Located runs for one page, including any found inside Do-invoked Form
 * XObjects. Used by locateCache.ts, which only needs to match a clicked
 * PDF.js text item to a run; it has no reason to know about Resources,
 * XObjects, or any other part of the object model (see contentStream.ts's
 * file header for why that boundary matters).
 */
export async function locatePageRuns(
  pdfBytes: Uint8Array,
  pageIndex: number,
): Promise<LocatedRun[]> {
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);
  const { streams, resolveForm } = decodePageContentStreams(doc, page);
  return parseContentStreams(streams, resolveForm);
}

/**
 * Concatenate decoded streams into one buffer, joined by a newline byte.
 * Exported for features/imageedit, which merges a page's content streams
 * back together the same way after editing exactly one of them.
 */
export function mergeStreams(streams: Uint8Array[]): Uint8Array {
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

const FONT_TAG = 'FolioEdit';

/** A content-stream number: fixed precision, no exponent, no trailing zeros. */
function formatNumber(n: number): string {
  const text = n.toFixed(4).replace(/\.?0+$/, '');
  return text === '' || text === '-0' ? '0' : text;
}

const COLOR_EPSILON = 0.5 / 255;

/**
 * The operators that stand in for the removed show-text operator. They sit
 * inside the original's BT/ET and inherit its Tm and CTM, so the replacement
 * lands on the original baseline origin with no coordinate conversion (runs
 * under a rotated or skewed matrix are not editable and never reach here).
 * Font, size, and (when it differs) fill color are switched for the
 * replacement and switched back afterwards. The font state is restored by
 * replaying the stream's own last Tf and every `gs` since it, in order,
 * because an ExtGState can select a font too and the stream may be relying
 * on that; re-emitting just the parsed font and size would change it.
 *
 * Tf's size operand is in text space; the style size is in user units, so it
 * is divided by the Tm/CTM scale the run was located with.
 *
 * Several lines are stacked downward by one font size each (`0 -L Td`), then
 * the line matrix is moved back up so whatever follows sees the Tlm the
 * original stream expects.
 */
function replacementOperators(
  run: LocatedRun,
  fontName: string,
  encodedLines: string[],
  style: CommitEditParams['style'],
): string {
  const scale = run.textScale !== 0 ? Math.abs(run.textScale) : 1;
  // Round once so the moves down and back up use the exact same leading.
  const size = Number(formatNumber(style.fontSize / scale));
  const { color } = style;
  const recolor =
    Math.abs(color.r - run.color.r) > COLOR_EPSILON ||
    Math.abs(color.g - run.color.g) > COLOR_EPSILON ||
    Math.abs(color.b - run.color.b) > COLOR_EPSILON;
  const rg = (c: { r: number; g: number; b: number }) =>
    `${formatNumber(c.r)} ${formatNumber(c.g)} ${formatNumber(c.b)} rg`;

  const ops = [`${PDFName.of(fontName).toString()} ${formatNumber(size)} Tf`];
  if (recolor) ops.push(rg(color));
  encodedLines.forEach((encoded, i) => {
    if (i > 0) ops.push(`0 ${formatNumber(-size)} Td`);
    if (encoded !== '') ops.push(`${encoded} Tj`);
  });
  if (encodedLines.length > 1) {
    ops.push(`0 ${formatNumber(size * (encodedLines.length - 1))} Td`);
  }
  if (run.tfOperator !== '') ops.push(run.tfOperator);
  for (const gs of run.gsOperators) ops.push(gs.raw);
  if (recolor) ops.push(rg(run.color));
  return ops.join(' ');
}

/**
 * pdf-lib's drawText normalization, which this feature used to get for free:
 * tabs and U+0085/U+2028/U+2029 become four spaces, backspace and vertical
 * tab are dropped, then the text splits into lines on \n, \f, \r. The
 * editor forwards contentEditable text unnormalized.
 */
function textLines(text: string): string[] {
  const cleaned = text.replace(/\t|\u0085|\u2028|\u2029/g, '    ').replace(/[\b\v]/g, '');
  return cleaned.split(/\r\n|[\n\f\r]/);
}

/**
 * Throw if a `gs` since the last Tf names an ExtGState that cannot be looked
 * up: it may select the font, so the state to restore cannot be known. A gs
 * with no /Font (alpha, overprint, ...) is the common case and is fine.
 */
function assertGsResolvable(
  run: LocatedRun,
  streamCount: number,
  pageResources: PDFDict | undefined,
  forms: Map<number, FormEntry>,
): void {
  for (const gs of run.gsOperators) {
    const resources = resourcesForStream(gs.streamIndex, streamCount, pageResources, forms);
    const extGState = resources
      ?.lookupMaybe(PDFName.of('ExtGState'), PDFDict)
      ?.lookupMaybe(PDFName.of(gs.name), PDFDict);
    if (!extGState) {
      throw new TexteditError(
        'run-not-found',
        'Could not read the graphics state this text depends on',
      );
    }
  }
}

export async function commitTextEdit(params: CommitEditParams): Promise<Uint8Array> {
  const { pdfBytes, pageIndex, target, newText, style } = params;
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);

  const { streams, resolveForm, forms } = decodePageContentStreams(doc, page);
  const runs = parseContentStreams(streams, resolveForm);
  const run = matchRunToItem(runs, target, { op: target.op });
  if (!run) {
    throw new TexteditError('run-not-found', 'Could not find that text in the page content');
  }
  if (!run.editable) {
    throw new TexteditError(
      run.blockedCode ?? 'run-not-editable',
      run.blockedReason ?? 'This text cannot be edited',
    );
  }

  // Validate and encode the replacement before touching anything, so an
  // unencodable character fails without any partial work.
  let font: PDFFont | undefined;
  let encodedLines: string[] = [];
  if (newText.length > 0) {
    const embedded = await doc.embedFont(standardFontFor(style.fontFamilyHint));
    font = embedded;
    try {
      encodedLines = textLines(newText).map((line) =>
        line === '' ? '' : embedded.encodeText(line).toString(),
      );
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

  if (font) assertGsResolvable(run, streams.length, page.node.Resources(), forms);

  if (run.streamIndex < streams.length) {
    // Run located in one of the page's own content streams.
    let insertion = '';
    if (font) {
      const fontName = page.node.newFontDictionary(FONT_TAG, font.ref).decodeText();
      insertion = replacementOperators(run, fontName, encodedLines, style);
    }
    const spliced = streams.map((bytes, i) =>
      i === run.streamIndex ? spliceRun(bytes, run, insertion) : bytes,
    );
    const mergedRef = doc.context.register(
      PDFRawStream.of(doc.context.obj({}), mergeStreams(spliced)),
    );
    page.node.set(PDFName.of('Contents'), mergedRef);
  } else {
    // Run located inside a Form XObject: splice a new copy of its stream and
    // redirect this page's Resources at that copy, rather than mutating the
    // (possibly shared) original. See this file's header and FormEntry.
    const entry = forms.get(run.streamIndex);
    if (!entry) {
      // Cannot happen: every streamIndex >= streams.length was handed out by
      // resolveForm, which always records an entry before returning one.
      // Guarded rather than asserted so a future refactor slip fails as an
      // ordinary thrown error here instead of a crash.
      throw new TexteditError('run-not-found', 'Could not find that text in the page content');
    }

    // The replacement lives inside the form, so its font has to be in the
    // form's own Resources (a form without /Resources uses the invoking
    // page's, so start from those). Both the Resources dict and its /Font
    // subdictionary are cloned: the originals may be shared with other forms
    // or pages.
    const copiedDict = copyStreamDict(doc, entry.dict);
    let insertion = '';
    if (font) {
      const baseResources =
        entry.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? entry.resourcesDict;
      const formResources = baseResources.clone(doc.context);
      const formFonts =
        baseResources.lookupMaybe(PDFName.of('Font'), PDFDict)?.clone(doc.context) ??
        doc.context.obj({});
      const fontKey = formFonts.uniqueKey(FONT_TAG);
      formFonts.set(fontKey, font.ref);
      formResources.set(PDFName.of('Font'), formFonts);
      copiedDict.set(PDFName.of('Resources'), formResources);
      insertion = replacementOperators(run, fontKey.decodeText(), encodedLines, style);
    }
    const splicedBytes = spliceRun(entry.bytes, run, insertion);

    // Rebuild the whole chain of forms from the edited one up to the page,
    // giving each level a stream of its own. Replacing only the edited form
    // would still write the redirect into its parent's /Resources in place,
    // and a parent form can be Do-invoked from another page just as readily
    // as the form holding the edit, so the change has to stop being
    // observable at every level rather than only the last one.
    let childRef = doc.context.register(PDFRawStream.of(copiedDict, splicedBytes));
    let level: FormEntry = entry;
    // The parser caps descent depth and refuses cycles, so this chain is
    // already finite. The visited set is belt and braces against a later
    // change to how parents get recorded turning the walk into a loop.
    const walked = new Set<number>();
    for (;;) {
      // PDFDict.clone is shallow, so cloning only the Resources dict would
      // still leave its /XObject subdictionary shared with whatever else
      // references it; clone both, redirect this level's name in the cloned
      // /XObject, and reattach.
      const clonedXObject = level.xobjectDict.clone(doc.context);
      clonedXObject.set(PDFName.of(level.name), childRef);
      const clonedResources = level.resourcesDict.clone(doc.context);
      clonedResources.set(PDFName.of('XObject'), clonedXObject);

      const parentId = level.parentStreamId;
      const parent = parentId === undefined ? undefined : forms.get(parentId);
      if (parentId === undefined || !parent || walked.has(parentId)) {
        // The page owns this level's Resources, so attaching here ends the
        // walk. A page is never shared, so nothing above it needs copying.
        page.node.set(PDFName.of('Resources'), clonedResources);
        break;
      }
      // A parent form owns it instead, so that form needs replacing too,
      // carrying the cloned Resources; its own owner gets redirected at the
      // copy on the next turn of the loop.
      walked.add(parentId);
      const parentDict = copyStreamDict(doc, parent.dict);
      parentDict.set(PDFName.of('Resources'), clonedResources);
      childRef = doc.context.register(PDFRawStream.of(parentDict, parent.bytes));
      level = parent;
    }
  }

  return doc.save();
}
