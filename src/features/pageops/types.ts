/** A page's zero-based position in the document a plan was built against. */
export type SourcePageIndex = number;

export type PageOpsErrorCode =
  'empty-plan' | 'page-out-of-range' | 'duplicate-page' | 'bad-rotation' | 'unreadable-result';

/**
 * A whole-document description of what the pages should become, expressed
 * against the document the plan was built from.
 *
 * Declaring the end state rather than a sequence of moves is what lets a drag
 * that crosses ten positions, or a delete of a scattered multi-page selection,
 * commit as a single mutation and a single undo step.
 */
export interface PagePlan {
  /**
   * Source page indices in the order the result should hold them. A source
   * index missing from this list is deleted; the list may not be empty, since
   * a PDF with no pages is not a PDF.
   */
  order: SourcePageIndex[];
  /**
   * Clockwise quarter-turns to add to a source page's existing rotation, in
   * degrees, keyed by source index. Relative rather than absolute so the UI
   * never has to read `/Rotate` (which is inheritable) to turn a page.
   */
  rotateBy?: Record<SourcePageIndex, number>;
}

export interface ApplyPagePlanParams {
  pdfBytes: Uint8Array;
  plan: PagePlan;
}

/** What a plan did, for announcements, undo labelling, and state remapping. */
export interface PagePlanResult {
  bytes: Uint8Array;
  /** Page count after the plan applied. */
  numPages: number;
  /**
   * New 1-based page number for each surviving source page, keyed by the
   * source page's 1-based number. Absent key means the page was deleted.
   */
  pageMap: Map<number, number>;
}
