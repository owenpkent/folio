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

/**
 * Whether `bytes` carries the `%PDF-` header, allowing it to sit up to
 * `searchLimit` bytes in.
 *
 * The limit is the caller's call, because the two callers legitimately differ:
 * the export feature validates this app's own output and can insist on offset
 * 0 (the default), while the combine feature validates files someone else
 * wrote, and the spec (ISO 32000, section 7.5.2 note) allows up to 1024 bytes
 * of junk before the header -- such files exist in the wild, and pdf-lib loads
 * them. Only the bound differs, so only the bound is a parameter: a
 * byte-matching or boundary bug here has one place to be fixed, not two.
 *
 * A flat nested loop rather than `PDF_HEADER.every(...)` per offset: the
 * callback form allocated a fresh closure at each of up to 1021 candidate
 * offsets for every staged and every merged file.
 */
export function hasPdfHeader(bytes: Uint8Array, searchLimit = 0): boolean {
  const lastStart = Math.min(bytes.length - PDF_HEADER.length, searchLimit);
  for (let start = 0; start <= lastStart; start++) {
    let matched = true;
    for (let i = 0; i < PDF_HEADER.length; i++) {
      if (bytes[start + i] !== PDF_HEADER[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}
