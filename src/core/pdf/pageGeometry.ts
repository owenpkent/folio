/**
 * Translating between the page the user sees and the page the file stores.
 *
 * Overlays (placed text, images, check marks, signatures, highlights, the OCR
 * layer) record their position as fractions of the page *as displayed*: that is
 * the box they were dragged around inside, and pdf.js sizes it from a viewport
 * that has already applied `/Rotate`. A page turned 90° therefore shows a box
 * whose sides are swapped relative to its MediaBox.
 *
 * Baking has to undo that. pdf-lib draws into unrotated user space, and the
 * reader then applies `/Rotate` to the finished page, so a stamp written at
 * face value onto a rotated page lands in the wrong corner and comes out
 * sideways. Everything that stamps an overlay goes through this module.
 */
import { degrees, type Degrees, type PDFPage } from 'pdf-lib';

/** A rectangle as fractions (0..1) of the displayed page, top-left origin. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A point as fractions (0..1) of the displayed page, top-left origin. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Where and how to draw a box so it reads upright once `/Rotate` is applied. */
export interface UserPlacement {
  /** pdf-lib's anchor: the drawn box's own bottom-left corner. */
  x: number;
  y: number;
  /** Extent along the drawn box's own axes, so unaffected by the page's turn. */
  width: number;
  height: number;
  /** The turn that cancels the page's, leaving the content upright on screen. */
  rotate: Degrees;
}

/** An axis-aligned box in PDF user space, for `/Rect` and `/QuadPoints`. */
export interface UserBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface PageGeometry {
  /** MediaBox size, which is the space pdf-lib draws into. */
  mediaWidth: number;
  mediaHeight: number;
  /** Displayed size, with the sides swapped on a quarter turn. */
  viewWidth: number;
  viewHeight: number;
  rotation: number;
}

export function normalizeAngle(angle: number): number {
  return (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
}

/**
 * Note this reads the MediaBox, matching every existing caller. A document
 * whose CropBox differs from its MediaBox is offset by that difference on
 * screen, which is a separate, pre-existing gap.
 */
function geometryOf(page: PDFPage): PageGeometry {
  const { width, height } = page.getSize();
  const rotation = normalizeAngle(page.getRotation().angle);
  const quarterTurned = rotation === 90 || rotation === 270;
  return {
    mediaWidth: width,
    mediaHeight: height,
    viewWidth: quarterTurned ? height : width,
    viewHeight: quarterTurned ? width : height,
    rotation,
  };
}

/**
 * A point on the displayed page (top-left origin, y down, in page units) as a
 * point in PDF user space (bottom-left origin, y up).
 *
 * Read the cases as "where did the paper's corners go": turning a page 90°
 * clockwise puts its bottom-left corner at the top left of the screen, so
 * screen-x runs along user-y and screen-y runs along user-x.
 */
function toUserSpace(g: PageGeometry, x: number, y: number): [number, number] {
  switch (g.rotation) {
    case 90:
      return [y, x];
    case 180:
      return [g.mediaWidth - x, y];
    case 270:
      return [g.mediaWidth - y, g.mediaHeight - x];
    default:
      return [x, g.mediaHeight - y];
  }
}

/**
 * Where to draw an overlay rect, for anything that renders its own content
 * (an image, a text box, a glyph) and so has to be turned as well as moved.
 */
export function placeRect(page: PDFPage, rect: NormalizedRect): UserPlacement {
  const g = geometryOf(page);
  const width = rect.width * g.viewWidth;
  const height = rect.height * g.viewHeight;
  // The anchor is the rect's bottom-left corner on screen, which is its
  // top-left plus its height, mapped back through the page's turn.
  const [x, y] = toUserSpace(g, rect.x * g.viewWidth, rect.y * g.viewHeight + height);
  return { x, y, width, height, rotate: degrees(g.rotation) };
}

/**
 * The user-space box an overlay rect covers, for anything positioned by extent
 * rather than drawn (a `/Rect`, a highlight's `/QuadPoints`), which the reader
 * turns along with the rest of the page.
 */
export function boxRect(page: PDFPage, rect: NormalizedRect): UserBox {
  const g = geometryOf(page);
  const left = rect.x * g.viewWidth;
  const top = rect.y * g.viewHeight;
  const [ax, ay] = toUserSpace(g, left, top);
  const [bx, by] = toUserSpace(
    g,
    left + rect.width * g.viewWidth,
    top + rect.height * g.viewHeight,
  );
  return {
    x0: Math.min(ax, bx),
    y0: Math.min(ay, by),
    x1: Math.max(ax, bx),
    y1: Math.max(ay, by),
  };
}

/**
 * A point `dx` to the right and `dy` up from a placement's anchor, measured
 * along the placement's own axes rather than the page's.
 *
 * Text is drawn from its baseline, not from the corner {@link placeRect}
 * returns, and on a turned page "up from the corner" is not user-space up. Any
 * stamper nudging a drawn object within its own box goes through this.
 */
export function offsetInFrame(
  placement: UserPlacement,
  dx: number,
  dy: number,
): { x: number; y: number } {
  switch (normalizeAngle(placement.rotate.angle)) {
    case 90:
      return { x: placement.x - dy, y: placement.y + dx };
    case 180:
      return { x: placement.x - dx, y: placement.y - dy };
    case 270:
      return { x: placement.x + dy, y: placement.y - dx };
    default:
      return { x: placement.x + dx, y: placement.y + dy };
  }
}

/** A length along the displayed page's x axis, in user-space units. */
export function scaleWidth(page: PDFPage, fraction: number): number {
  const g = geometryOf(page);
  return fraction * g.viewWidth;
}

/** A length along the displayed page's y axis, in user-space units. */
export function scaleHeight(page: PDFPage, fraction: number): number {
  const g = geometryOf(page);
  return fraction * g.viewHeight;
}

/**
 * An overlay rect after the page under it turns by `delta` degrees clockwise.
 *
 * Positions are fractions of the displayed page, so turning the page moves
 * every overlay within its own frame; without this a signature would slide off
 * what it was signing the moment the page rotated.
 */
export function rotateNormalizedRect(rect: NormalizedRect, delta: number): NormalizedRect {
  switch (normalizeAngle(delta)) {
    case 90:
      return { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
    case 180:
      return { x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height, ...sides(rect) };
    case 270:
      return { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width };
    default:
      return { ...rect };
  }
}

/** The same turn, for overlays anchored to a point rather than a box. */
export function rotateNormalizedPoint(point: NormalizedPoint, delta: number): NormalizedPoint {
  switch (normalizeAngle(delta)) {
    case 90:
      return { x: 1 - point.y, y: point.x };
    case 180:
      return { x: 1 - point.x, y: 1 - point.y };
    case 270:
      return { x: point.y, y: 1 - point.x };
    default:
      return { ...point };
  }
}

function sides(rect: NormalizedRect): { width: number; height: number } {
  return { width: rect.width, height: rect.height };
}
