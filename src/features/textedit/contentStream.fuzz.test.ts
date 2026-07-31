import { fc, test } from '@fast-check/vitest';
import { describe, expect } from 'vitest';

import {
  parseContentStreams,
  removeOperatorBytes,
  spliceBytes,
  spliceOperatorBytes,
  spliceRun,
  type ResolvedForm,
} from './contentStream';

/**
 * Property tests for the content-stream tokenizer and the byte-splicing
 * primitives built on it.
 *
 * These run over bytes lifted straight out of a PDF, so every offset they hand
 * back is attacker-influenced, and every one of them is later fed to a
 * `Uint8Array.set()` that will throw (or silently corrupt the document) if it is
 * out of range. The invariants worth pinning are therefore less about what the
 * parser finds than about the offsets it reports being usable at all.
 */

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

/** PDF whitespace and delimiters, i.e. what the tokenizer treats as a break. */
const BOUNDARY = new Set([...[0, 9, 10, 12, 13, 32], ...ascii('()<>[]{}/%')]);

/**
 * Fragments of real content-stream syntax. Random bytes tokenize into garbage
 * operators and never reach the interesting state machine (BT/ET nesting, text
 * matrices, form descent), so most generated input is assembled from these.
 */
const FRAGMENTS = [
  'BT',
  'ET',
  'Tj',
  'TJ',
  "'",
  '"',
  'Td',
  'TD',
  'Tm',
  'T*',
  'Tf',
  'Tc',
  'Tw',
  'q',
  'Q',
  'cm',
  'Do',
  're',
  'W',
  'n',
  'rg',
  'g',
  'k',
  '(hello)',
  '(a\\)b)',
  '<48656c6c6f>',
  '[(a) -200 (b)] ',
  '/F1',
  '/Im1',
  '12',
  '-3.5',
  '0',
  '1e9',
  '.',
  '-',
  '%comment\n',
  'BI /W 4 ID xxxx EI',
];

const syntaxish = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 120 })
  .map((parts) => Uint8Array.from(ascii(parts.join(' '))));

const streamBytes = fc.oneof(
  { weight: 3, arbitrary: syntaxish },
  { weight: 1, arbitrary: fc.uint8Array({ maxLength: 2048 }) },
);

const streamList = fc.array(streamBytes, { minLength: 1, maxLength: 3 });

describe('parseContentStreams (fuzz)', () => {
  test.prop([streamList], {
    examples: [
      [[new Uint8Array(0)]],
      [[Uint8Array.from(ascii('BT'))]],
      // Unterminated constructs: the tokenizer must not run off the end.
      [[Uint8Array.from(ascii('BT (unterminated'))]],
      [[Uint8Array.from(ascii('<48'))]],
      [[Uint8Array.from(ascii('BI /W 4 ID no-ei-follows'))]],
    ],
  })('is total, and every run it reports is spliceable', (streams) => {
    const runs = parseContentStreams(streams);

    for (const run of runs) {
      // An out-of-range streamIndex would index undefined at splice time.
      expect(run.streamIndex).toBeGreaterThanOrEqual(0);
      expect(run.streamIndex).toBeLessThan(streams.length);

      const stream = streams[run.streamIndex];
      expect(run.start).toBeGreaterThanOrEqual(0);
      expect(run.end).toBeGreaterThanOrEqual(run.start);
      expect(run.end).toBeLessThanOrEqual(stream.length);

      // Every numeric field feeds layout maths; a NaN would propagate into the
      // overlay's CSS and position the edit box nowhere.
      expect(Number.isFinite(run.x)).toBe(true);
      expect(Number.isFinite(run.y)).toBe(true);
      expect(Number.isFinite(run.fontSize)).toBe(true);
    }
  });

  /**
   * The offsets are only useful if acting on them actually works. Splicing out
   * every run the parser reported, back to front so earlier offsets stay valid,
   * must never throw and must never grow the stream.
   */
  test.prop([streamList])('every reported run can be spliced out', (streams) => {
    const runs = parseContentStreams(streams);

    for (let i = 0; i < streams.length; i += 1) {
      const mine = runs.filter((r) => r.streamIndex === i).sort((a, b) => b.start - a.start);
      // Widened: spliceRun returns a fresh array whose buffer type is not the
      // narrowed one the generator produced.
      let bytes: Uint8Array<ArrayBufferLike> = streams[i];
      const before = bytes.length;
      for (const run of mine) bytes = spliceRun(bytes, run);
      // spliceRun substitutes short replacements for ' and ", so this is not
      // strictly monotonic per run, but removing text can never balloon a stream.
      expect(bytes.length).toBeLessThanOrEqual(before + mine.length * 32);
    }
  });

  /**
   * A hostile resolver that answers every name with a form invoking another
   * name. Only the current path is checked for cycles, so without the total
   * descent cap this fans out exponentially and hangs the tab at open.
   */
  test.prop([fc.integer({ min: 1, max: 6 })], { numRuns: 5 })(
    'terminates against a form resolver that always resolves',
    (fanout) => {
      const body = Uint8Array.from(
        ascii(Array.from({ length: fanout }, (_, i) => `/F${i} Do`).join(' ')),
      );
      let calls = 0;
      const resolveForm = (_name: string, _from: number): ResolvedForm | undefined => {
        calls += 1;
        return { streamId: 1, bytes: body };
      };

      const started = performance.now();
      parseContentStreams([body], resolveForm);
      expect(performance.now() - started).toBeLessThan(2000);
      // The documented total-descent cap, not merely "it finished".
      expect(calls).toBeLessThanOrEqual(512);
    },
  );
});

describe('spliceBytes (fuzz)', () => {
  const spliceCase = fc
    .record({
      stream: fc.uint8Array({ maxLength: 512 }),
      replacement: fc.uint8Array({ maxLength: 64 }),
    })
    .chain(({ stream, replacement }) =>
      fc.tuple(fc.nat({ max: stream.length }), fc.nat({ max: stream.length })).map(([i, j]) => ({
        stream,
        replacement,
        start: Math.min(i, j),
        end: Math.max(i, j),
      })),
    );

  test.prop([spliceCase])('replaces exactly the named window', (c) => {
    const out = spliceBytes(c.stream, c.start, c.end, c.replacement);

    expect(out.length).toBe(c.stream.length - (c.end - c.start) + c.replacement.length);
    expect([...out.subarray(0, c.start)]).toEqual([...c.stream.subarray(0, c.start)]);
    expect([...out.subarray(c.start, c.start + c.replacement.length)]).toEqual([...c.replacement]);
    expect([...out.subarray(c.start + c.replacement.length)]).toEqual([
      ...c.stream.subarray(c.end),
    ]);
  });

  test.prop([spliceCase])('splicing a window back over itself is the identity', (c) => {
    const out = spliceBytes(c.stream, c.start, c.end, c.stream.subarray(c.start, c.end));
    expect([...out]).toEqual([...c.stream]);
  });

  /**
   * The invariant both operator splices exist for: the seam must not glue two
   * tokens together. Two adjacent bytes only tokenize apart when at least one is
   * a boundary byte, so at each seam one side or the other has to be one.
   */
  test.prop([spliceCase])('an operator splice never glues tokens at either seam', (c) => {
    const out = spliceOperatorBytes(c.stream, c.start, c.end, c.replacement);

    if (c.replacement.length === 0) {
      expect([...out]).toEqual([...removeOperatorBytes(c.stream, c.start, c.end)]);
      return;
    }

    const head = out[c.start - 1];
    const first = out[c.start];
    if (c.start > 0 && first !== undefined) {
      expect(BOUNDARY.has(head) || BOUNDARY.has(first)).toBe(true);
    }

    // Locate the trailing seam: it sits just past the replacement, allowing for
    // the space spliceOperatorBytes may have inserted ahead of it.
    const tailAt = out.length - (c.stream.length - c.end);
    const last = out[tailAt - 1];
    const next = out[tailAt];
    if (next !== undefined && last !== undefined) {
      expect(BOUNDARY.has(last) || BOUNDARY.has(next)).toBe(true);
    }
  });
});
