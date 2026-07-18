/**
 * Cache of one page's located show-text runs (see ./contentStream), so
 * repeated exploratory clicks on the same page do not each re-serialize the
 * whole document and re-parse its content streams.
 *
 * A single slot is enough: only one page is ever being probed at a time, and
 * form-value changes never alter page content streams, so the cached runs
 * stay valid across clicks until the next edit or undo bumps docVersion (or
 * the document itself changes, which clears the slot outright).
 */

import { getEngine } from '@/core/pdf';

import { parseContentStreams } from './contentStream';
import { getPageContentStreams } from './mutate';
import type { LocatedRun } from './types';

interface CacheEntry {
  docVersion: number;
  pageIndex: number;
  runs: LocatedRun[];
}

let cache: CacheEntry | null = null;

/** Located runs for `pageIndex` at `docVersion`, from cache when available. */
export async function getLocatedRuns(docVersion: number, pageIndex: number): Promise<LocatedRun[]> {
  if (cache && cache.docVersion === docVersion && cache.pageIndex === pageIndex) {
    return cache.runs;
  }
  const pdfBytes = await getEngine().saveDocument();
  const streams = await getPageContentStreams(pdfBytes, pageIndex);
  const runs = parseContentStreams(streams);
  cache = { docVersion, pageIndex, runs };
  return runs;
}

/** Drop any cached runs. Call whenever the open document changes or closes. */
export function clearLocatedRunsCache(): void {
  cache = null;
}
