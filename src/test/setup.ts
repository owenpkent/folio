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
 * Driven by the environment so the two jobs that run these want different
 * things from the same files: a pull request wants a byte-for-byte reproducible
 * gate, so it pins FC_SEED and keeps the run short; a nightly job wants to
 * explore, so it leaves the seed unset and raises FC_NUM_RUNS. A failure prints
 * both the seed and the shrink path, which replay exactly via
 * `test.prop(arbs, { seed, path, endOnFailure: true })`.
 *
 * The time limit is a backstop for the DoS-shaped properties: a regression that
 * makes a scanner quadratic should fail the suite rather than hang CI.
 * `markInterruptAsFailure` stays false so hitting it on a slow machine reports
 * the runs that did complete instead of inventing a failure.
 */
const seed = process.env.FC_SEED ? Number(process.env.FC_SEED) : undefined;

fc.configureGlobal({
  numRuns: Number(process.env.FC_NUM_RUNS ?? 100),
  ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}),
  interruptAfterTimeLimit: 30_000,
  markInterruptAsFailure: false,
});
