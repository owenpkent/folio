import { getEngine } from './index';
import type { PageDimensions } from './types';

/**
 * Intrinsic (scale-1) page sizes, measured lazily.
 *
 * Every `Page` used to measure itself on mount, which meant opening a document
 * fired one `getPageDimensions` per page in a single burst: a worker round-trip
 * and a retained page object for all of them, before the user had scrolled
 * anywhere. It fired again, in full, on every zoom step, because the measure
 * was taken at the current scale.
 *
 * Both problems come from measuring the wrong thing. A page's size at scale is
 * just its intrinsic size times the scale, so one measurement serves every zoom
 * level, and until it arrives page 1's size is a good enough stand-in for the
 * layout box. Pages then measure themselves only when the user gets near them,
 * and a uniform document (almost all of them) never notices the estimate was an
 * estimate.
 *
 * This is what pdf.js's own viewer does: every page view is constructed with a
 * default viewport cloned from the first page, and past a threshold it stops
 * measuring the rest at all.
 */

const sizes = new Map<number, PageDimensions>();
const inFlight = new Set<number>();
const listeners = new Set<() => void>();
let fallback: PageDimensions | null = null;
/**
 * Which document the numbers in `sizes` describe. Bumped by
 * {@link resetPageSizes}; see the check in {@link measurePage}.
 */
let generation = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to size changes. Shaped for `useSyncExternalStore`. */
export function subscribePageSizes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The best known intrinsic size for a page: its own once measured, otherwise
 * the document-wide estimate, otherwise null before anything is known.
 *
 * Returns a stable reference per page so `useSyncExternalStore` does not see a
 * new object on every render and loop.
 */
export function getIntrinsicSize(pageNumber: number): PageDimensions | null {
  return sizes.get(pageNumber) ?? fallback;
}

/** Seed the estimate from page 1, which the viewer already fetches for fit. */
export function primePageSizeEstimate(dimensions: PageDimensions): void {
  fallback = dimensions;
  emit();
}

/** Measure one page, at most once. Safe to call on every render. */
export function measurePage(pageNumber: number): void {
  if (sizes.has(pageNumber) || inFlight.has(pageNumber)) return;
  inFlight.add(pageNumber);
  // The document these dimensions will describe. A measurement is a worker
  // round-trip, so on a large document there is a real window in which the
  // user can close or switch documents before it lands.
  const measuredFor = generation;

  void getEngine()
    .getPageDimensions(pageNumber, 1)
    .then((dimensions) => {
      // A measurement that started before the last reset describes the
      // previous document. Nothing else would catch it: the reset cleared
      // inFlight and sizes, so this write would land in the new document's
      // map and stay there, and page N would lay out at the old document's
      // size for as long as it stays open. Dropping the inFlight entry is
      // guarded too, because the new document may already have a measurement
      // of its own in flight for this page and this stale one must not clear
      // its marker.
      if (measuredFor !== generation) return;
      inFlight.delete(pageNumber);
      const previous = sizes.get(pageNumber) ?? fallback;
      sizes.set(pageNumber, dimensions);
      // Only notify when the estimate was actually wrong. In a document whose
      // pages are all one size -- which is most of them -- this makes the whole
      // measuring pass free of re-renders.
      if (
        !previous ||
        previous.width !== dimensions.width ||
        previous.height !== dimensions.height
      ) {
        emit();
      }
    })
    .catch(() => {
      if (measuredFor !== generation) return;
      inFlight.delete(pageNumber);
    });
}

/** Drop everything. Call when the open document changes. */
export function resetPageSizes(): void {
  generation += 1;
  sizes.clear();
  inFlight.clear();
  fallback = null;
  emit();
}
