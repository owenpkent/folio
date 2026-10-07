import type { PDFDocument } from 'pdf-lib';

import { UnsafeOutputError } from './errors';
import { reopenPageCount } from './reopenPageCount';

/** Reopens output bytes and returns their page count; rejects if unreadable. */
export type PageCountVerifier = (bytes: Uint8Array) => Promise<number>;

/**
 * Save a pdf-lib document and prove the result reopens with `expectedPages`.
 *
 * pdf-lib will happily write a file no reader can open: an object numbered near
 * 2^31 makes it allocate numbers above it and emit an xref stream PDF.js rejects.
 * So the bytes are reopened in a detached PDF.js document before anyone writes
 * them. On failure it retries once without object streams, which avoids that
 * class of defect, and throws {@link UnsafeOutputError} if that fails too.
 *
 * `addDefaultPage: false` so a document pdf-lib read as empty can never turn into
 * a blank A4 page; the page count check then catches it instead.
 *
 * `verify` is injectable so unit tests need no PDF.js worker.
 */
export async function saveVerified(
  pdf: PDFDocument,
  expectedPages: number,
  verify: PageCountVerifier = reopenPageCount,
): Promise<Uint8Array> {
  let firstProblem = '';
  for (const useObjectStreams of [true, false]) {
    const bytes = await pdf.save({ addDefaultPage: false, useObjectStreams });
    try {
      const actual = await verify(bytes);
      if (actual === expectedPages) return bytes;
      firstProblem ||= `it reopened with ${actual} of ${expectedPages} pages`;
    } catch (error) {
      firstProblem ||= `it would not reopen: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  throw new UnsafeOutputError(firstProblem);
}
