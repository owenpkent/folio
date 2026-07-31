import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach } from 'vitest';

// Testing Library registers this itself only when the test globals are exposed,
// and this project runs with `globals: false`. Without it every rendered tree
// stays mounted for the rest of the file, so a component holding module-level
// state (a shared IntersectionObserver, say) is still holding it when the next
// test starts.
afterEach(cleanup);

/**
 * Global fast-check settings for the `*.fuzz.test.ts` property tests.
 *
 * Driven by the environment so the `fuzz` job in .github/workflows/ci.yml can
 * want two different things from the same files: its smoke step runs on every
 * pull request and wants a byte-for-byte reproducible gate, so it pins FC_SEED
 * and keeps FC_NUM_RUNS low; its nightly step wants to explore, so it leaves the
 * seed unset and lets FC_NUM_RUNS default to 20,000. A failure prints both the
 * seed and the shrink path, which replay exactly via
 * `test.prop(arbs, { seed, path, endOnFailure: true })`.
 *
 * The time limit is a backstop for the DoS-shaped properties: a regression that
 * makes a scanner quadratic should fail the suite rather than hang CI. It only
 * gates anything if the test is allowed to outlive it, so `testTimeout` in
 * vite.config.ts sits above it and `markInterruptAsFailure` turns the interrupt
 * into the failure this comment claims. A full 20,000-iteration pass takes a few
 * seconds, so 30s is only reached by something pathological.
 */

/**
 * Read an integer out of the environment, or undefined when it is unset.
 *
 * Throws on a malformed value rather than falling back to the default: silence
 * is what made `FC_NUM_RUNS=20k` mean NaN, and NaN runs is zero runs, which
 * every property in the suite passes without executing a single case.
 */
function intEnv(name: string, min: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, but was ${JSON.stringify(raw)}.`);
  }
  return value;
}

// Any 32-bit integer is a valid fast-check seed, including a negative one.
const seed = intEnv('FC_SEED', -(2 ** 31));
const numRuns = intEnv('FC_NUM_RUNS', 1) ?? 100;

fc.configureGlobal({
  numRuns,
  ...(seed !== undefined ? { seed } : {}),
  interruptAfterTimeLimit: 30_000,
  markInterruptAsFailure: true,
});
