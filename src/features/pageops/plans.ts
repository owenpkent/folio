/**
 * Turning a selection plus a gesture into a {@link PagePlan}.
 *
 * Pure index arithmetic, kept away from the stores and pdf-lib so the fiddly
 * part (where a dragged block lands once its own pages are lifted out of the
 * list) can be tested on its own.
 *
 * Selections arrive as 1-based page numbers, matching what the UI shows. Plans
 * speak 0-based source indices, matching pdf-lib.
 */
import type { PagePlan } from './types';

/** Quarter turn clockwise, in degrees. Negative turns anticlockwise. */
export const QUARTER_TURN = 90;

export function identityOrder(numPages: number): number[] {
  return Array.from({ length: numPages }, (_, index) => index);
}

/** The selection as sorted 0-based indices. */
function sourceIndices(pages: Iterable<number>): number[] {
  return [...pages].sort((a, b) => a - b).map((page) => page - 1);
}

/** Drop the selected pages. Returns null when that would empty the document. */
export function deletePlan(numPages: number, pages: Set<number>): PagePlan | null {
  const order = identityOrder(numPages).filter((index) => !pages.has(index + 1));
  return order.length === 0 ? null : { order };
}

/**
 * Move the selected pages to a drop point.
 *
 * `dropIndex` counts the pages above the drop point in the *current* list, so 0
 * is above page 1 and `numPages` is below the last page — the same numbering
 * the gaps between thumbnails use.
 */
export function movePlan(numPages: number, pages: Set<number>, dropIndex: number): PagePlan {
  const moving = sourceIndices(pages);
  const movingSet = new Set(moving);
  const rest = identityOrder(numPages).filter((index) => !movingSet.has(index));

  // Lifting the selection out of the list slides the drop point up by however
  // many of the moved pages sat above it.
  const liftedAbove = moving.filter((index) => index < dropIndex).length;
  const at = Math.max(0, Math.min(rest.length, dropIndex - liftedAbove));

  return { order: [...rest.slice(0, at), ...moving, ...rest.slice(at)] };
}

/**
 * Shift the selection one place up (`-1`) or down (`+1`), the keyboard
 * equivalent of a short drag. Returns null when it is already at that end.
 *
 * A selection with gaps in it gathers into one block as it moves, which is the
 * same thing dragging it would do.
 */
export function nudgePlan(numPages: number, pages: Set<number>, delta: -1 | 1): PagePlan | null {
  const moving = sourceIndices(pages);
  if (moving.length === 0) return null;

  if (delta === -1) {
    const first = moving[0];
    if (first === 0) return null;
    return movePlan(numPages, pages, first - 1);
  }

  const last = moving[moving.length - 1];
  if (last === numPages - 1) return null;
  // Two past the last selected page: one to clear the page itself, one to land
  // below the page it is swapping with.
  return movePlan(numPages, pages, last + 2);
}

/** Turn the selected pages, leaving the order alone. */
export function rotatePlan(numPages: number, pages: Set<number>, degrees: number): PagePlan | null {
  if (pages.size === 0) return null;
  const rotateBy: Record<number, number> = {};
  for (const index of sourceIndices(pages)) rotateBy[index] = degrees;
  return { order: identityOrder(numPages), rotateBy };
}
