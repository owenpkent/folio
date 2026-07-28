/**
 * Cache of one page's located images (see ./mutate), so repeated exploratory
 * clicks on the same page do not each re-serialize the whole document and
 * re-parse its content streams. Mirrors features/textedit/locateCache.ts.
 *
 * A single slot is enough: only one page is ever being probed at a time, and
 * form-value changes never alter page content streams, so the cached images
 * stay valid across clicks until the next edit bumps docVersion (or the
 * document itself changes, which clears the slot outright).
 */

import { getEngine } from '@/core/pdf';

import { locatePageImages } from './mutate';
import type { LocatedImage } from './types';

interface CacheEntry {
  docVersion: number;
  pageIndex: number;
  images: LocatedImage[];
}

let cache: CacheEntry | null = null;

/** Located images for `pageIndex` at `docVersion`, from cache when available. */
export async function getLocatedImages(
  docVersion: number,
  pageIndex: number,
): Promise<LocatedImage[]> {
  if (cache && cache.docVersion === docVersion && cache.pageIndex === pageIndex) {
    return cache.images;
  }
  const pdfBytes = await getEngine().saveDocument();
  const images = await locatePageImages(pdfBytes, pageIndex);
  cache = { docVersion, pageIndex, images };
  return images;
}

/** Drop any cached images. Call whenever the open document changes or closes. */
export function clearLocatedImagesCache(): void {
  cache = null;
}
