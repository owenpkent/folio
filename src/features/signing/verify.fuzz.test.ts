import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';

import { detectSignatures } from './verify';

/**
 * Property tests for the one PDF parser a hostile document reaches with no user
 * action at all: {@link detectSignatures} runs on every open, over the whole
 * file, on the main thread.
 *
 * Blind `fc.uint8Array()` is close to useless here. The scanner keys off the
 * literal `/ByteRange`, which random bytes produce with probability ~256^-10, so
 * an unstructured fuzz would spend every run on the not-found path. The
 * generators below emit signature-shaped documents with attacker-chosen offsets,
 * mixed with some genuine noise.
 */

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** The bytes `onlySpaceAfter` treats as whitespace. */
const SPACE_BYTES = [9, 10, 11, 12, 13, 32, 160];

/**
 * Mirrors of the scanner's internal caps, which verify.ts does not export. The
 * two properties at the bottom assert the observable consequence of each cap, so
 * a value drifting out of sync here surfaces as a failing property rather than
 * as a test that quietly stopped checking anything.
 */
const MAX_RESULTS = 50;
const MAX_SITES = 200;
const MAX_GAP = 4 * 1024 * 1024;
const MAX_WINDOW_BUDGET = 16 * 1024 * 1024;

const hexString = fc
  .array(fc.constantFrom(...'0123456789abcdefABCDEF'.split('')), { maxLength: 128 })
  .map((chars) => chars.join(''));

/** Spacing the /ByteRange regex has to tolerate. */
const spacing = fc.constantFrom('', ' ', '  ', '\r\n', '\t');

/**
 * Trailing bytes that cannot themselves introduce a second signature site:
 * dropping '/' from the alphabet means the generated tail can never contain
 * `/ByteRange`. That is what lets the security property below reason about
 * "the" match rather than having to work out which of several it got.
 */
const tailNoSlash = fc.array(
  fc.integer({ min: 0, max: 255 }).filter((b) => b !== 0x2f),
  { maxLength: 256 },
);

/** A signature dictionary with completely arbitrary /ByteRange numbers. */
const arbitraryOffsets = fc
  .record({
    lead: fc.uint8Array({ maxLength: 256 }),
    a: fc.nat({ max: 2 ** 32 - 1 }),
    b: fc.nat({ max: 2 ** 32 - 1 }),
    c: fc.nat({ max: 2 ** 32 - 1 }),
    d: fc.nat({ max: 2 ** 32 - 1 }),
    ws: spacing,
    contents: hexString,
    tail: fc.uint8Array({ maxLength: 256 }),
  })
  .map(({ lead, a, b, c, d, ws, contents, tail }) =>
    Uint8Array.from([
      ...lead,
      ...ascii(`/ByteRange${ws}[${ws}${a} ${b} ${c} ${d}${ws}]`),
      ...ascii(`/Contents <${contents}>`),
      ...ascii('/M (D:20260101000000)'),
      ...tail,
    ]),
  );

const anyInput = fc.oneof(
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 4096 }) },
  { weight: 4, arbitrary: arbitraryOffsets },
);

describe('detectSignatures (fuzz)', () => {
  test.prop([anyInput], {
    examples: [
      [new Uint8Array(0)],
      [Uint8Array.from(ascii('/ByteRange'))],
      [Uint8Array.from(ascii('/ByteRange [0 0 0 0]'))],
      // The offsets that made coversWholeDocument true vacuously.
      [Uint8Array.from(ascii('/ByteRange [0 1 999999999 1]TAMPERED'))],
      [Uint8Array.from(ascii('/ByteRange [4294967295 4294967295 4294967295 4294967295]'))],
    ],
  })('is total, and every result is well formed', (bytes) => {
    const results = detectSignatures(bytes);

    expect(results.length).toBeLessThanOrEqual(MAX_RESULTS);
    for (const r of results) {
      expect(typeof r.coversWholeDocument).toBe('boolean');
      expect(r.signerName === null || typeof r.signerName === 'string').toBe(true);
      if (r.signingTime !== null) {
        expect(r.signingTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      }
    }
  });

  /**
   * The claim the UI turns into a green "No changes after signing" badge, so
   * this is the property that actually matters. A signature may only be reported
   * as covering the whole document when the range it names ends inside the file
   * AND nothing but whitespace follows it.
   */
  test.prop([
    fc.record({
      body: fc.uint8Array({ maxLength: 512 }),
      contents: hexString,
      ws: spacing,
      // Deliberately unconstrained: the point is that offsets are attacker data.
      claimedC: fc.oneof(fc.nat({ max: 4096 }), fc.nat({ max: 2 ** 32 - 1 })),
      claimedD: fc.oneof(fc.nat({ max: 4096 }), fc.nat({ max: 2 ** 32 - 1 })),
      tail: tailNoSlash,
    }),
  ])('never certifies a document whose signed range does not end at real bytes', (spec) => {
    const bytes = Uint8Array.from([
      ...spec.body,
      ...ascii(`/ByteRange${spec.ws}[0 0 ${spec.claimedC} ${spec.claimedD}${spec.ws}]`),
      ...ascii(`/Contents <${spec.contents}>`),
      ...spec.tail,
    ]);

    const end = spec.claimedC + spec.claimedD;
    const trulyCovers =
      end <= bytes.length && bytes.subarray(end).every((b) => SPACE_BYTES.includes(b));

    for (const r of detectSignatures(bytes)) {
      expect(r.coversWholeDocument).toBe(trulyCovers);
    }
  });

  /**
   * Bounded work. The scanner runs synchronously on the main thread at open, so
   * a document that makes it superlinear is a denial of service on the UI, not
   * just a slow open. Repeating the literal site marker is the cheapest way for
   * a file to try: it costs a window decode and a regex per occurrence while
   * producing no results at all, so the result cap alone does not bound it.
   *
   * Pinned through the site cap's documented cost rather than a stopwatch. A
   * wall-clock bound is flaky in CI and, worse, was not a bound at all here: the
   * largest document this can build costs tens of milliseconds against a 1000ms
   * assertion, so deleting the cap left the property green. What the cap really
   * buys is that a genuine signature parked behind MAX_SITES decoy markers is
   * deliberately not reported, and that is exactly observable.
   */
  test.prop([fc.integer({ min: 1, max: 500 })], {
    numRuns: 25,
    examples: [[MAX_SITES - 1], [MAX_SITES], [MAX_SITES + 1]],
  })('stops examining candidate sites once a document has passed the site cap', (decoys) => {
    // A bare marker is a site the scanner must look at and reject: no '[' ever
    // follows, so it matches nothing and contributes no result.
    const bytes = Uint8Array.from([
      ...ascii('/ByteRange'.repeat(decoys)),
      ...ascii('/ByteRange [0 0 0 0]/Contents <00>'),
    ]);

    // The real dictionary is site number `decoys + 1`, so it is reached only
    // while the decoys on their own have not used the site budget up.
    expect(detectSignatures(bytes)).toHaveLength(decoys < MAX_SITES ? 1 : 0);
  });

  /**
   * The other half of the same concern: valid dictionaries whose /ByteRange each
   * names an enormous gap. Per-window caps do not bound their product with the
   * result cap, so the total decoded across a scan is budgeted too.
   *
   * Also pinned through a consequence rather than a stopwatch, and for a sharper
   * reason: latin1 clamps its window to the file length, so a few-KB document
   * can never actually decode past its own size and the timing version passed
   * with the budget set to Infinity. What the budget does change is how far the
   * scan gets: every dictionary here claims a full MAX_GAP window, so only a
   * handful fit and the scan stops well short of the result cap.
   */
  test.prop([fc.integer({ min: MAX_RESULTS + 10, max: 200 })], { numRuns: 10 })(
    'stops before the result cap when the claimed windows exhaust the budget',
    (count) => {
      const one = ascii('/ByteRange [0 0 900000000 900000000]/Contents <00>');
      const bytes = new Uint8Array(one.length * count);
      for (let i = 0; i < count; i += 1) bytes.set(one, i * one.length);

      const results = detectSignatures(bytes);

      // Each dictionary claims at least MAX_GAP, so no more of them can be
      // examined than the budget pays for -- and the file supplies well over
      // MAX_RESULTS of them, so it is the budget stopping the scan, not the
      // result cap.
      expect(results.length).toBeLessThanOrEqual(Math.ceil(MAX_WINDOW_BUDGET / MAX_GAP));
      // The budget must still be loose enough to report the first signature.
      expect(results.length).toBeGreaterThan(0);
      // Every one of them names a range ending far past EOF, so none may pass.
      for (const r of results) expect(r.coversWholeDocument).toBe(false);
    },
  );
});
