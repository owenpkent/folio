/**
 * Typed failures for the paths that write a PDF. Each carries a message meant
 * to be shown to the user as is (exportForSave puts it in the toast), so they
 * say what happened and that nothing was written.
 */

/**
 * pdf-lib saw a different number of pages than the viewer does. The usual cause
 * is a page object whose generation number does not match its /Kids reference,
 * which pdf-lib treats as no page at all; saving would drop those pages (or
 * insert a blank one), and any edits placed on them would silently vanish.
 */
export class PageCountMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Folio can't safely edit this PDF: it reads ${actual} of its ${expected} pages. Nothing was written, and your document is unchanged.`,
    );
    this.name = 'PageCountMismatchError';
  }
}

/**
 * The bytes pdf-lib produced do not reopen with the expected page count, even
 * after the compatibility retry. Refusing is the only safe answer: writing them
 * would replace a readable file with an unreadable one.
 */
export class UnsafeOutputError extends Error {
  constructor(detail: string) {
    super(
      `Folio couldn't produce a valid copy of this PDF (${detail}). Nothing was written, and your document is unchanged.`,
    );
    this.name = 'UnsafeOutputError';
  }
}

/**
 * Something staged for a page that the pdf-lib copy does not have. Skipping it
 * would drop the user's edit without a word, so stamping stops instead.
 */
export class MissingPageError extends Error {
  constructor(readonly pageNumber: number) {
    super(
      `Folio can't place an edit on page ${pageNumber} because that page was not found in the file. Nothing was written, and your document is unchanged.`,
    );
    this.name = 'MissingPageError';
  }
}
