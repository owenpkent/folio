// Pure baseline logic for the corpus harness, kept apart from the harness so
// it can be unit tested by `npm test` without a corpus on disk.

export type Status =
  | 'ok'
  | 'skip-unreadable'
  | 'skip-encrypted'
  | 'refused'
  | 'save-threw'
  | 'reopen-failed'
  | 'page-count-changed'
  | 'text-changed'
  | 'pdflib-load-failed'
  | 'bake-threw'
  | 'bake-reopen-failed'
  | 'bake-page-count-changed'
  | 'timeout';

/** The committed baseline: filename to status, nothing else. */
export type Baseline = Record<string, Status>;

/**
 * A regression is a file that was `ok` and no longer is, or one that failed
 * with a clean typed refusal and now crashes or writes bad output. The same
 * status as before is never a regression, so an intentional refusal recorded
 * in the baseline stays acceptable. `skip-*` statuses describe the input, not
 * Folio, so they are never compared, and a file new to the baseline has
 * nothing to regress from.
 */
export function isRegression(was: Status | undefined, now: Status): boolean {
  if (was === undefined || now === was || now === 'ok' || now.startsWith('skip')) return false;
  if (was === 'ok') return true;
  return was === 'refused';
}

/**
 * The baseline to write after a run. A full run replaces the file, so entries
 * for PDFs that left the corpus drop out. A partial run (a filter or a limit
 * selected some files) only updates the files it tested and keeps every other
 * entry, so one focused run cannot silently discard the rest of the coverage.
 * Keys are sorted so diffs are reviewable.
 */
export function mergeBaseline(
  existing: Baseline,
  results: Iterable<{ file: string; status: Status }>,
  opts: { partial: boolean },
): Baseline {
  const merged: Baseline = opts.partial ? { ...existing } : {};
  for (const { file, status } of results) merged[file] = status;
  const entries = Object.entries(merged);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}
