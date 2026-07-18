/**
 * In-place editing of existing PDF text (feature: textedit).
 *
 * Unlike features/editing (additive-only text boxes), this feature removes the
 * original show-text operator from the page content stream and draws replacement
 * text at the same baseline origin. Pipeline:
 *   1. contentStream.ts parses decoded page content streams and locates every
 *      show-text operator (Tj / TJ / ' / ") with its byte range, baseline
 *      origin in PDF user space, font, size, and fill color.
 *   2. The UI matches a clicked PDF.js text item to a located run by baseline
 *      origin proximity.
 *   3. mutate.ts splices the operator out with pdf-lib and draws the new text.
 */

/** Fill color captured from the graphics state, normalized to sRGB 0..1. */
export interface RunColor {
  r: number;
  g: number;
  b: number;
}

/** Show-text operator kinds we can locate. */
export type ShowOp = 'Tj' | 'TJ' | "'" | '"';

/** A show-text operator located in a page's content stream(s). */
export interface LocatedRun {
  /** Index into the page's Contents array (0 when the page has one stream). */
  streamIndex: number;
  /** Byte offset of the operator's first operand in the decoded stream. */
  start: number;
  /** Byte offset just past the operator token in the decoded stream. */
  end: number;
  op: ShowOp;
  /**
   * Baseline origin of the run in PDF user space (pre-viewport). For ' and "
   * this is the origin after the operator's implicit T* line advance.
   */
  x: number;
  y: number;
  /** Effective font size in user units (Tf size scaled by Tm and CTM). */
  fontSize: number;
  /** Font resource name selected by the active Tf, e.g. "F3". */
  fontResource: string;
  /** Fill color active at the show op. */
  color: RunColor;
  /**
   * False when editing this run is unsafe: the next show op in the same BT
   * block depends on this run's advance (no intervening positioning op), or
   * the text matrix is rotated/skewed.
   */
  editable: boolean;
  /** Human-readable reason when editable is false. */
  blockedReason?: string;
}

/** Baseline origin of a PDF.js text item (transform[4], transform[5]). */
export interface PageTextItemRef {
  x: number;
  y: number;
}

export type TexteditErrorCode =
  | 'run-not-found'
  | 'run-not-editable'
  | 'unencodable-text'
  | 'page-out-of-range';

export interface CommitStyle {
  /** CSS-ish family hint from PDF.js styles + fontName, used to pick a standard font. */
  fontFamilyHint: string;
  /** Replacement font size in PDF user units. */
  fontSize: number;
  color: RunColor;
}

export interface CommitEditParams {
  /** Current canonical document bytes (must already include form values). */
  pdfBytes: Uint8Array;
  /** 0-based page index. */
  pageIndex: number;
  /** Baseline origin + op kind used to re-locate the run inside pdfBytes. */
  target: PageTextItemRef & { op: ShowOp };
  /** Empty string deletes the run without drawing replacement text. */
  newText: string;
  style: CommitStyle;
}
