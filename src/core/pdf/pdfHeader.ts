/** ASCII `%PDF-`, the header every PDF starts with (allowing for leading junk; see callers). */
export const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d];

/**
 * The smallest payload that could plausibly be a PDF.
 *
 * A file needs the header, a catalog, a page tree, at least one page object, a
 * cross-reference table and the trailer before it is openable at all; the
 * smallest hand-built valid PDFs are several hundred bytes. The floor only has
 * to separate "a real document" from "a few stray bytes that happen to spell
 * %PDF-", so it sits well under any genuine PDF, this app's own output included.
 */
export const MIN_PDF_BYTES = 256;
