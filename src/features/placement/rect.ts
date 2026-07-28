import type { PagePoint, PlacedRect, PlacementAnchor } from './types';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * A rect of the given size positioned at `point` and kept fully on the page.
 *
 * `anchor` is what the point means: 'topLeft' for text (typing starts where
 * the user clicked, which is how they read the click) and 'center' for images
 * and signatures (the artwork lands under the cursor).
 */
export function rectAt(
  point: PagePoint,
  width: number,
  height: number,
  anchor: PlacementAnchor,
): PlacedRect {
  const w = clamp(width, 0, 1);
  const h = clamp(height, 0, 1);
  const left = anchor === 'center' ? point.x - w / 2 : point.x;
  const top = anchor === 'center' ? point.y - h / 2 : point.y;
  return { x: clamp(left, 0, 1 - w), y: clamp(top, 0, 1 - h), width: w, height: h };
}

/** The point the keyboard path places at: the middle of the page. */
export const PAGE_CENTER: PagePoint = { x: 0.5, y: 0.5 };
