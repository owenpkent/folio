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
 * promise; in-flight tasks are not cancelled, and queued ones are abandoned. If
 * a partial result is acceptable, hand in a task that swallows its own failures.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    // Read-then-increment is atomic here: JS is single-threaded and there is no
    // await between the two lines, so no two workers can claim the same index.
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
