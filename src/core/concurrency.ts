/**
 * Run `task` over every item with at most `limit` of them in flight at once.
 *
 * `Promise.all(items.map(task))` starts every task in the same tick. That is
 * fine for a handful of items and ruinous for one task per page of a long
 * document, where the peak cost scales with the page count instead of with
 * anything the machine can be expected to have. This keeps a fixed pool of
 * workers pulling from a shared cursor, so the peak is bounded by `limit`.
 *
 * Results come back in input order. The first rejection rejects the returned
 * promise; tasks already in flight are not cancelled (there is nothing to
 * cancel them with), but nothing further is started, so a failure does not go
 * on paying for a full run whose result nobody will read. If a partial result
 * is acceptable, hand in a task that swallows its own failures.
 *
 * `limit` must be a finite number of at least 1. Anything else is a caller bug,
 * not a value worth guessing at: the previous silent clamp turned `NaN` into
 * zero workers, which resolved with an array of holes and ran nothing at all.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isFinite(limit) || limit < 1) {
    throw new RangeError(`mapWithConcurrency needs a limit of at least 1, got ${String(limit)}`);
  }

  const results = new Array<R>(items.length);
  const workers = Math.min(Math.floor(limit), items.length);
  let cursor = 0;
  let failed = false;

  const run = async (): Promise<void> => {
    // Read-then-increment is atomic here: JS is single-threaded and there is no
    // await between the two lines, so no two workers can claim the same index.
    while (!failed && cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        // The flag is what actually abandons the queue. Promise.all rejects the
        // caller on the first failure, but the sibling workers are ordinary
        // loops that would otherwise keep draining the cursor to the end.
        failed = true;
        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
