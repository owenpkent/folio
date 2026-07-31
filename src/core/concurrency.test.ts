import { describe, expect, it, vi } from 'vitest';

import { mapWithConcurrency } from './concurrency';

/** A promise plus the handles to settle it from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and returns results in input order', async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return n * 2;
    });

    expect(peak).toBe(3);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it('starts a queued task only once a slot frees up', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];

    const all = mapWithConcurrency([0, 1, 2], 2, async (index) => {
      started.push(index);
      await gates[index].promise;
      return index;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve();
    gates[2].resolve();
    expect(await all).toEqual([0, 1, 2]);
  });

  it('handles an empty list without spinning', async () => {
    expect(await mapWithConcurrency([], 8, async () => 1)).toEqual([]);
  });

  it('rejects a limit it cannot honour rather than running nothing', async () => {
    const task = vi.fn(async (n: number) => n);

    // NaN was the dangerous one: it used to survive the clamp, produce zero
    // workers, and resolve with an array of holes having run no task at all.
    for (const limit of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      await expect(mapWithConcurrency([1, 2], limit, task)).rejects.toThrow(RangeError);
    }
    expect(task).not.toHaveBeenCalled();
  });

  it('rejects with the first failure', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('abandons queued tasks once one has failed', async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (index) => {
        started.push(index);
        await Promise.resolve();
        if (index === 0) throw new Error('boom');
        return index;
      }),
    ).rejects.toThrow('boom');

    // Let any worker that wrongly kept draining the cursor get its turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Only the two that were already in flight ever ran. Before the failure
    // flag both workers drained the cursor to the end, so all six started even
    // though the caller had been rejected on the first.
    expect(started).toEqual([0, 1]);
  });
});
