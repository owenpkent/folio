import { describe, expect, it } from 'vitest';

import { matchRunToItem, parseContentStreams, spliceRun } from './contentStream';
import type { LocatedRun } from './types';

const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe('parseContentStreams', () => {
  it('locates a single Tj with correct origin, size, resource, and byte range', () => {
    const src = 'BT /F1 12 Tf 100 700 Td (Hello) Tj ET';
    const bytes = encode(src);
    const runs = parseContentStreams([bytes]);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.op).toBe('Tj');
    expect(run.x).toBeCloseTo(100);
    expect(run.y).toBeCloseTo(700);
    expect(run.fontSize).toBeCloseTo(12);
    expect(run.fontResource).toBe('F1');
    expect(run.editable).toBe(true);
    // start is the first operand's start, end is just past the operator token.
    expect(decode(bytes.slice(run.start, run.end))).toBe('(Hello) Tj');
  });

  it('scales origin and font size by cm concatenated with Tm', () => {
    const src = 'q 2 0 0 2 0 0 cm BT /F1 10 Tf 1 0 0 1 5 5 Tm (A) Tj ET Q';
    const runs = parseContentStreams([encode(src)]);

    expect(runs).toHaveLength(1);
    // combined = Tm x CTM = [1 0 0 1 5 5] x [2 0 0 2 0 0] = [2 0 0 2 10 10]
    expect(runs[0].x).toBeCloseTo(10);
    expect(runs[0].y).toBeCloseTo(10);
    expect(runs[0].fontSize).toBeCloseTo(20);
  });

  it('Q restores the CTM (and fill color) saved by q', () => {
    const src = 'q 2 0 0 2 0 0 cm Q BT /F1 10 Tf 1 0 0 1 5 5 Tm (A) Tj ET';
    const runs = parseContentStreams([encode(src)]);

    // If Q had not restored the CTM this would be (10, 10) / size 20, as above.
    expect(runs[0].x).toBeCloseTo(5);
    expect(runs[0].y).toBeCloseTo(5);
    expect(runs[0].fontSize).toBeCloseTo(10);
  });

  it('Q restores the font resource and size (Tf) saved by q', () => {
    const src = '/F1 12 Tf q /F2 20 Tf BT (A) Tj ET Q BT 1 0 0 1 10 10 Tm (B) Tj ET';
    const runs = parseContentStreams([encode(src)]);

    expect(runs).toHaveLength(2);
    expect(runs[0].fontResource).toBe('F2');
    expect(runs[0].fontSize).toBeCloseTo(20);
    // Without a Q restore this would still see F2 / size 20, leaked past the Q.
    expect(runs[1].fontResource).toBe('F1');
    expect(runs[1].fontSize).toBeCloseTo(12);
  });

  it('Q restores the leading (TL) saved by q, used by a later T*', () => {
    const src = '20 TL q 5 TL Q BT T* (B) Tj ET';
    const runs = parseContentStreams([encode(src)]);

    expect(runs).toHaveLength(1);
    // T* advances by -TL; if the inner TL (5) had leaked past Q this would be -5.
    expect(runs[0].y).toBeCloseTo(-20);
  });

  it('TD sets TL and advances the line; T* repeats the advance using TL', () => {
    const src = 'BT /F1 10 Tf 0 0 Td 5 -20 TD (A) Tj T* (B) Tj ET';
    const runs = parseContentStreams([encode(src)]);

    expect(runs).toHaveLength(2);
    expect(runs[0].x).toBeCloseTo(5);
    expect(runs[0].y).toBeCloseTo(-20);
    expect(runs[1].x).toBeCloseTo(5);
    expect(runs[1].y).toBeCloseTo(-40);
    // T* intervenes between them, so neither is advance-blocked.
    expect(runs[0].editable).toBe(true);
    expect(runs[1].editable).toBe(true);
  });

  it('\' and " compute their origin after the implicit T* line advance', () => {
    const src = `BT /F1 10 Tf 1 0 0 1 0 100 Tm 20 TL (First) ' 0 0 (Second) " ET`;
    const runs = parseContentStreams([encode(src)]);

    expect(runs).toHaveLength(2);
    expect(runs[0].op).toBe("'");
    expect(runs[0].x).toBeCloseTo(0);
    expect(runs[0].y).toBeCloseTo(80);
    expect(runs[1].op).toBe('"');
    expect(runs[1].x).toBeCloseTo(0);
    expect(runs[1].y).toBeCloseTo(60);
    // ' always resets position itself, so it never blocks on advance-dependency.
    expect(runs[0].editable).toBe(true);
    expect(runs[1].editable).toBe(true);
  });

  it('tokenizes a TJ array (kerning numbers, literal and hex strings) as one operation', () => {
    const src = 'BT /F1 12 Tf 0 0 Td [(AB) -50 <4344> 30 (EF)] TJ ET';
    const bytes = encode(src);
    const runs = parseContentStreams([bytes]);

    expect(runs).toHaveLength(1);
    expect(runs[0].op).toBe('TJ');
    expect(decode(bytes.slice(runs[0].start, runs[0].end))).toBe('[(AB) -50 <4344> 30 (EF)] TJ');
  });

  it('skips inline images (BI...ID...EI) without corrupting later parsing', () => {
    // Binary image data (arbitrary bytes, here a single 0xff sample) is never
    // fed through the tokenizer; only the BI..ID dict entries are.
    const stream = bytesOf(
      'q BI /W 1 /H 1 /BPC 8 /CS /G ID ',
      [0xff],
      ' EI Q BT /F1 12 Tf 0 0 Td (X) Tj ET',
    );
    const runs = parseContentStreams([stream]);

    expect(runs).toHaveLength(1);
    expect(runs[0].op).toBe('Tj');
    expect(runs[0].x).toBeCloseTo(0);
    expect(runs[0].y).toBeCloseTo(0);
  });

  describe('fill color', () => {
    it('tracks rg and copies color into the run (not a live reference)', () => {
      const src =
        '1 0 0 rg BT /F1 12 Tf 0 0 Td (Red) Tj ET 0 1 0 rg BT /F1 12 Tf 0 -20 Td (Green) Tj ET';
      const runs = parseContentStreams([encode(src)]);

      expect(runs).toHaveLength(2);
      expect(runs[0].color).toEqual({ r: 1, g: 0, b: 0 });
      expect(runs[1].color).toEqual({ r: 0, g: 1, b: 0 });
      expect(runs[0].color).not.toBe(runs[1].color);
    });

    it('tracks g as gray (r === g === b)', () => {
      const src = '0.5 g BT /F1 12 Tf 0 0 Td (Gray) Tj ET';
      const runs = parseContentStreams([encode(src)]);
      expect(runs[0].color).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    });

    it('converts k (cmyk) with r=(1-c)(1-k) etc', () => {
      const src = '1 0 0 0 k BT /F1 12 Tf 0 0 Td (Cyan) Tj ET';
      const runs = parseContentStreams([encode(src)]);
      expect(runs[0].color.r).toBeCloseTo(0);
      expect(runs[0].color.g).toBeCloseTo(1);
      expect(runs[0].color.b).toBeCloseTo(1);
    });

    it('scn with 3 numeric operands behaves like rg', () => {
      const src = '0.2 0.4 0.6 scn BT /F1 12 Tf 0 0 Td (A) Tj ET';
      const runs = parseContentStreams([encode(src)]);
      expect(runs[0].color).toEqual({ r: 0.2, g: 0.4, b: 0.6 });
    });
  });

  describe('editable flag', () => {
    it('blocks a run when the next show op has no intervening positioning operator', () => {
      const src = 'BT /F1 12 Tf 0 0 Td (A) Tj (B) Tj ET';
      const runs = parseContentStreams([encode(src)]);

      expect(runs).toHaveLength(2);
      expect(runs[0].editable).toBe(false);
      expect(runs[0].blockedReason).toBe('This text shares positioning with adjacent text');
      // Nothing follows (B) Tj before ET, so it is unaffected.
      expect(runs[1].editable).toBe(true);
    });

    it('blocks rotated or skewed text', () => {
      const src = 'BT /F1 12 Tf 0 1 -1 0 50 50 Tm (R) Tj ET';
      const runs = parseContentStreams([encode(src)]);

      expect(runs[0].editable).toBe(false);
      expect(runs[0].blockedReason).toBe('Rotated or skewed text is not supported yet');
    });
  });
});

describe('spliceRun', () => {
  it('removes a Tj cleanly when the adjacent bytes are already boundaries', () => {
    const src = 'BT /F1 12 Tf 0 0 Td (Hello) Tj ET';
    const bytes = encode(src);
    const run = parseContentStreams([bytes])[0];

    const spliced = spliceRun(bytes, run);
    const expected = src.slice(0, run.start) + src.slice(run.end);
    expect(decode(spliced)).toBe(expected);
    expect(decode(spliced)).not.toContain('Tj');
    expect(parseContentStreams([spliced])).toHaveLength(0);
  });

  it('inserts a single space when closing the gap would glue tokens together', () => {
    const src = 'BT /F1 12 Tf 0 0 Td(Hello) Tj ET'; // no space between Td and (
    const bytes = encode(src);
    const run = parseContentStreams([bytes])[0];

    const spliced = spliceRun(bytes, run);
    const expected = src.slice(0, run.start) + ' ' + src.slice(run.end);
    expect(decode(spliced)).toBe(expected);
  });

  it('leaves the rest of a multi-run stream byte-identical and re-parseable', () => {
    const src = 'BT /F1 12 Tf 0 0 Td (First) Tj 0 -20 Td (Second) Tj ET';
    const bytes = encode(src);
    const runs = parseContentStreams([bytes]);
    expect(runs).toHaveLength(2);

    const spliced = spliceRun(bytes, runs[0]);
    const reparsed = parseContentStreams([spliced]);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0].x).toBeCloseTo(runs[1].x);
    expect(reparsed[0].y).toBeCloseTo(runs[1].y);
  });

  it("replaces ' with a bare T* so the line advance survives", () => {
    const src = "BT /F1 12 Tf 0 0 Td 20 TL (Line) ' ET";
    const bytes = encode(src);
    const run = parseContentStreams([bytes])[0];

    const spliced = spliceRun(bytes, run);
    const expected = src.slice(0, run.start) + 'T*' + src.slice(run.end);
    expect(decode(spliced)).toBe(expected);
    expect(parseContentStreams([spliced])).toHaveLength(0);
  });

  it('replaces " with the verbatim aw/ac operands plus Tw/Tc/T*', () => {
    const src = 'BT /F1 12 Tf 0 0 Td 20 TL 2 0.5 (Line) " ET';
    const bytes = encode(src);
    const run = parseContentStreams([bytes])[0];

    const spliced = spliceRun(bytes, run);
    const expected = src.slice(0, run.start) + '2 Tw 0.5 Tc T*' + src.slice(run.end);
    expect(decode(spliced)).toBe(expected);
    expect(decode(spliced)).not.toContain('(Line)');
  });
});

describe('matchRunToItem', () => {
  it('returns the nearest run within tolerance, not merely the first qualifying one', () => {
    const near = makeRun({ x: 1, y: 0, fontSize: 12 }); // distance 1, tolerance 3
    const far = makeRun({ x: 2, y: 0, fontSize: 40 }); // distance 2, tolerance 10 (also qualifies)
    expect(matchRunToItem([far, near], { x: 0, y: 0 })).toBe(near);
  });

  it('returns undefined when nothing is within tolerance', () => {
    const run = makeRun({ x: 100, y: 100, fontSize: 12 });
    expect(matchRunToItem([run], { x: 0, y: 0 })).toBeUndefined();
  });

  it('floors tolerance at 2 user units even for a tiny font size', () => {
    const run = makeRun({ x: 1.5, y: 0, fontSize: 4 }); // 25% of 4 is 1, but the floor is 2
    expect(matchRunToItem([run], { x: 0, y: 0 })).toBe(run);
  });

  it('excludes a run once its (fontSize-scaled) tolerance is too small', () => {
    const run = makeRun({ x: 0, y: 9, fontSize: 4 }); // tolerance 2, distance 9
    expect(matchRunToItem([run], { x: 0, y: 0 })).toBeUndefined();
  });

  it('filters by op, even when a closer run of the wrong op exists', () => {
    const tj = makeRun({ op: 'Tj', x: 0.5, y: 0 });
    const tJ = makeRun({ op: 'TJ', x: 1.5, y: 0 });
    expect(matchRunToItem([tj, tJ], { x: 0, y: 0 }, { op: 'TJ' })).toBe(tJ);
    expect(matchRunToItem([tj, tJ], { x: 0, y: 0 })).toBe(tj);
  });
});

/** Build a full LocatedRun for matchRunToItem tests, which only care about a few fields. */
function makeRun(overrides: Partial<LocatedRun>): LocatedRun {
  return {
    streamIndex: 0,
    start: 0,
    end: 0,
    op: 'Tj',
    x: 0,
    y: 0,
    fontSize: 12,
    fontResource: 'F1',
    color: { r: 0, g: 0, b: 0 },
    editable: true,
    ...overrides,
  };
}

/** Build a byte stream from a mix of ASCII text chunks and raw byte arrays (for BI/EI tests). */
function bytesOf(...parts: Array<string | number[]>): Uint8Array {
  const chunks: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      for (const ch of part) chunks.push(ch.charCodeAt(0));
    } else {
      chunks.push(...part);
    }
  }
  return Uint8Array.from(chunks);
}
