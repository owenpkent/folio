/**
 * "Click to place" mode, shared by the tools that drop something onto a page
 * (text box, image, signature). A tool arms a pending placement and the next
 * click on a page decides where the item lands, instead of dropping it in the
 * middle of the page and leaving the user to drag it into position.
 */

/** A point on a page as fractions (0..1) of its size, top-left origin. */
export interface PagePoint {
  x: number;
  y: number;
}

/** A rectangle as fractions (0..1) of the page, top-left origin. */
export interface PlacedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What the placement point means: the item's top-left corner, or its middle.
 * Each tool has a default that suits a click (text starts where you clicked,
 * artwork lands under the cursor); the keyboard path overrides it.
 */
export type PlacementAnchor = 'topLeft' | 'center';

export interface PendingPlacement {
  /** Names the thing being placed, for the hint banner and screen readers. */
  label: string;
  /**
   * Let a click that lands on an interactive AcroForm widget reach the widget
   * instead of placing anything, leaving the tool armed.
   *
   * Off by default, and rightly so: the click-catcher covers the whole page
   * above PDF.js's forms layer, but for most tools the user has explicitly
   * armed "put one here" and a field underneath is unrelated content that
   * happens to overlap. Only the check-mark tool sets this, because a mark is
   * *defined* as the stand-in for a printed checkbox with no field behind it
   * (see features/editing/types.ts), so a real widget under the click is
   * exactly the case where a mark is the wrong answer.
   */
  deferToFormWidget?: boolean;
  /**
   * Drop the item on `pageNumber` at `point`. `anchor` overrides the tool's
   * own default, which is what the keyboard path uses to center the item on
   * the page rather than hang it off the middle.
   */
  place(pageNumber: number, point: PagePoint, anchor?: PlacementAnchor): void | Promise<void>;
}
