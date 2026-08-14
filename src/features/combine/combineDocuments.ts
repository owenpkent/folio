import { PDFDocument } from 'pdf-lib';

/** One PDF to fold into the combined document, in the order it should appear. */
export interface CombineInput {
  name: string;
  bytes: Uint8Array;
}

/** Title set on the merged document's metadata. */
const COMBINED_TITLE = 'Combined document';

/**
 * Merge PDFs into one document: every page of the first input, then every
 * page of the second, and so on, in input order.
 *
 * Each input is validated with {@link looksLikePdf} before pdf-lib ever
 * touches it, and `PDFDocument.load` is never called with `ignoreEncryption`,
 * so a corrupt or password-protected file fails loudly (naming the offending
 * file) rather than silently combining a document nobody could actually open.
 */
export async function combinePdfs(inputs: CombineInput[]): Promise<Uint8Array> {
  if (inputs.length < 2) {
    throw new Error('Choose at least two PDFs to combine');
  }

  const out = await PDFDocument.create();
  out.setTitle(COMBINED_TITLE);

  for (const input of inputs) {
    const src = await loadInput(input);
    // pdf-lib's parser is lenient about malformed content: a corrupt file
    // often loads without `PDFDocument.load` itself throwing, then fails once
    // something walks its (missing or broken) page tree. Both stages are
    // wrapped the same way so either failure still names the offending file.
    try {
      const pages = await out.copyPages(src, src.getPageIndices());
      for (const page of pages) out.addPage(page);
    } catch (error) {
      throw namedError(input.name, error);
    }
  }

  return out.save();
}

/**
 * Cheap page count for one input, for the combine modal's per-row display.
 * Shares {@link loadInput}'s validation, so a file the modal cannot even
 * count pages for is one {@link combinePdfs} would also reject later.
 */
export async function countPdfPages(bytes: Uint8Array, name: string): Promise<number> {
  const doc = await loadInput({ name, bytes });
  try {
    return doc.getPageCount();
  } catch (error) {
    throw namedError(name, error);
  }
}

// The spec (ISO 32000, section 7.5.2 note) allows up to 1024 bytes of junk
// before the `%PDF-` header, and such files exist in the wild; pdf-lib loads
// them. So unlike the export feature's `isPlausiblePdf`, which validates our
// own output and can insist the header comes first, this scan has to be
// lenient about where the header sits.
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const HEADER_SEARCH_LIMIT = 1024 + PDF_HEADER.length;

function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - PDF_HEADER.length, HEADER_SEARCH_LIMIT);
  for (let start = 0; start <= limit; start++) {
    if (PDF_HEADER.every((byte, i) => bytes[start + i] === byte)) return true;
  }
  return false;
}

async function loadInput(input: CombineInput): Promise<PDFDocument> {
  if (!looksLikePdf(input.bytes)) {
    throw new Error(`"${input.name}" does not look like a PDF`);
  }
  try {
    return await PDFDocument.load(input.bytes);
  } catch (error) {
    throw namedError(input.name, error);
  }
}

/** Wrap a lower-level failure so it names which input caused it. */
function namedError(name: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`Could not read "${name}": ${reason}`);
}
