import { describe, expect, it } from 'vitest';

import {
  matchRunToItem,
  parseContentStreams,
  spliceOperatorBytes,
  spliceRun,
  type FormResolver,
  type LocatedImageOp,
  type ResolvedForm,
} from './contentStream';
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

  describe('Form XObjects (Do)', () => {
    it('descends into a Do-invoked form, composing its Matrix into page space', () => {
      const formSrc = 'BT /F1 10 Tf 5 5 Td (Hi) Tj ET';
      const resolver = formResolver({
        Fm1: { streamId: 1, bytes: encode(formSrc), matrix: [2, 0, 0, 2, 100, 200] },
      });
      const runs = parseContentStreams([encode('/Fm1 Do')], resolver);

      expect(runs).toHaveLength(1);
      // tm after "5 5 Td" is [1 0 0 1 5 5]; ctm is the form's Matrix (page
      // ctm is identity, so cm-composition leaves it unchanged); combined =
      // tm x ctm = [2 0 0 2 110 210] (x: 5*2+100, y: 5*2+200).
      expect(runs[0].x).toBeCloseTo(110);
      expect(runs[0].y).toBeCloseTo(210);
      expect(runs[0].fontSize).toBeCloseTo(20); // 10 * scaleY (2)
      expect(runs[0].streamIndex).toBe(1); // the resolver's assigned id, not the page's
      expect(runs[0].editable).toBe(true);
    });

    it('skips Do when the resolver reports it is not a form (e.g. an image)', () => {
      const src = 'q /Im1 Do Q BT /F1 12 Tf 0 0 Td (After) Tj ET';
      const runs = parseContentStreams([encode(src)], () => undefined);

      expect(runs).toHaveLength(1);
      expect(runs[0].x).toBeCloseTo(0);
      expect(runs[0].y).toBeCloseTo(0);
    });

    it('does not leak tm/tlm across a Do boundary, and does not treat the runs on either side as sharing positioning', () => {
      // No BT in the form itself: entering and leaving relies entirely on
      // Do's own save/restore of tm/tlm, not on the BT-reset every other
      // test in this file exercises.
      const formSrc = '1 0 0 1 9 9 Tm (FormText) Tj';
      const src = 'BT /F1 10 Tf 100 100 Td (Before) Tj /Fm1 Do (After) Tj ET';
      const resolver = formResolver({ Fm1: { streamId: 1, bytes: encode(formSrc) } });
      const runs = parseContentStreams([encode(src)], resolver);

      expect(runs).toHaveLength(3);
      expect(runs[0].x).toBeCloseTo(100); // "Before", at the outer Td
      expect(runs[0].y).toBeCloseTo(100);
      expect(runs[1].x).toBeCloseTo(9); // "FormText", the form's own Tm
      expect(runs[1].y).toBeCloseTo(9);
      // "After": the outer tm as restored, not "FormText"'s (9, 9) leaking out.
      expect(runs[2].x).toBeCloseTo(100);
      expect(runs[2].y).toBeCloseTo(100);
      expect(runs.every((r) => r.editable)).toBe(true);
    });

    it('still blocks rotated or skewed text located inside a form', () => {
      const formSrc = 'BT /F1 12 Tf 0 1 -1 0 50 50 Tm (R) Tj ET';
      const resolver = formResolver({ Fm1: { streamId: 1, bytes: encode(formSrc) } });
      const runs = parseContentStreams([encode('/Fm1 Do')], resolver);

      expect(runs).toHaveLength(1);
      expect(runs[0].editable).toBe(false);
      expect(runs[0].blockedReason).toBe('Rotated or skewed text is not supported yet');
    });

    it('does not descend into a form that would create a cycle, and blocks editing it', () => {
      const formSrc = 'BT /F1 10 Tf 0 0 Td (A) Tj ET /Fm1 Do BT /F1 10 Tf 0 -20 Td (B) Tj ET';
      const resolver = formResolver({ Fm1: { streamId: 1, bytes: encode(formSrc) } });
      const runs = parseContentStreams([encode('/Fm1 Do')], resolver);

      // The nested, self-referential Do is not descended into: both of the
      // form's own runs are located exactly once each, and nothing loops.
      expect(runs).toHaveLength(2);
      expect(runs[0].x).toBeCloseTo(0);
      expect(runs[0].y).toBeCloseTo(0);
      expect(runs[1].x).toBeCloseTo(0);
      expect(runs[1].y).toBeCloseTo(-20);
      // Declining the descent does not make the form single-use: a conforming
      // viewer draws its content once per recursion level, so splicing a run
      // out of its bytes would change every level while the replacement is
      // drawn at one. The invocation is counted before the cycle guard runs
      // precisely so the multiply-invoked sweep still sees it.
      for (const run of runs) {
        expect(run.editable).toBe(false);
        expect(run.blockedCode).toBe('run-in-shared-xobject');
      }
    });

    it('counts an invocation the depth cap declines, so a doubly-drawn deep form is still blocked', () => {
      // Fm1 is drawn twice: once directly by the page, and once from the
      // bottom of a chain deeper than MAX_FORM_DEPTH, where the descent is
      // declined. Counting only successful descents would record one
      // invocation and leave its text editable, and splicing it would then
      // change both draws.
      const DEPTH = 8; // must match MAX_FORM_DEPTH in contentStream.ts
      const forms: Record<string, ResolvedForm> = {
        Fm1: { streamId: 1, bytes: encode('BT /F1 10 Tf 0 0 Td (Shared) Tj ET') },
      };
      for (let level = 2; level <= DEPTH + 1; level++) {
        // The chain's last link names Fm1, at a depth the guard refuses.
        const nextDo = level <= DEPTH ? ` /Fm${level + 1} Do` : ' /Fm1 Do';
        forms[`Fm${level}`] = { streamId: level, bytes: encode(`${nextDo}`) };
      }
      const runs = parseContentStreams([encode('/Fm1 Do /Fm2 Do')], formResolver(forms));

      expect(runs).toHaveLength(1);
      expect(runs[0].editable).toBe(false);
      expect(runs[0].blockedCode).toBe('run-in-shared-xobject');
    });

    it('does not descend past MAX_FORM_DEPTH nested forms', () => {
      const DEPTH = 8; // must match MAX_FORM_DEPTH in contentStream.ts
      const forms: Record<string, ResolvedForm> = {};
      for (let level = 1; level <= DEPTH + 1; level++) {
        const nextDo = level <= DEPTH ? ` /Fm${level + 1} Do` : '';
        forms[`Fm${level}`] = {
          streamId: level,
          bytes: encode(`BT /F1 10 Tf 0 0 Td (L${level}) Tj ET${nextDo}`),
        };
      }
      const runs = parseContentStreams([encode('/Fm1 Do')], formResolver(forms));

      // Forms 1..DEPTH are reached (their own text is located); the form one
      // level deeper than that is never descended into.
      expect(runs).toHaveLength(DEPTH);
      expect(runs.some((r) => r.streamIndex === DEPTH + 1)).toBe(false);
    });

    it('bounds total descents, so a wide nest of forms cannot blow up the parse', () => {
      // The depth cap alone does not bound the work: only the CURRENT path is
      // checked for cycles, so a form reached down a different branch is
      // descended into again. Each of these levels invokes the next one four
      // times, which without a total-work cap costs 4^8 = 65536 traversals of
      // an untrusted document's streams.
      const FANOUT = 4;
      const LEVELS = 8;
      const forms: Record<string, ResolvedForm> = {};
      for (let level = 1; level <= LEVELS; level++) {
        const nextDo = level < LEVELS ? ` /Fm${level + 1} Do`.repeat(FANOUT) : '';
        forms[`Fm${level}`] = {
          streamId: level,
          bytes: encode(`BT /F1 10 Tf 0 0 Td (L${level}) Tj ET${nextDo}`),
        };
      }

      const started = performance.now();
      const runs = parseContentStreams([encode('/Fm1 Do'.repeat(FANOUT))], formResolver(forms));
      const elapsedMs = performance.now() - started;

      // MAX_FORM_DESCENTS is 512, and every located run comes from one
      // descent, so the run count cannot exceed it however wide the nest is.
      expect(runs.length).toBeLessThanOrEqual(512);
      // Generous enough not to flake on a loaded machine, while still far
      // below what an unbounded traversal of this fixture would take.
      expect(elapsedMs).toBeLessThan(2000);
    });

    it('blocks runs inside a Form XObject invoked more than once on the page', () => {
      const formSrc = 'BT /F1 10 Tf 0 0 Td (Stamp) Tj ET';
      const resolver = formResolver({ Fm1: { streamId: 1, bytes: encode(formSrc) } });
      const runs = parseContentStreams([encode('/Fm1 Do /Fm1 Do')], resolver);

      expect(runs).toHaveLength(2);
      for (const run of runs) {
        expect(run.editable).toBe(false);
        expect(run.blockedReason).toBe(
          'This text is part of a template used more than once on the page',
        );
        expect(run.blockedCode).toBe('run-in-shared-xobject');
      }
    });

    it('does not block a form invoked once each across two independent parseContentStreams calls', () => {
      // Guards against a regression where invocationCounts leaked across
      // calls; each call (i.e. each page) gets its own guard state.
      const formSrc = 'BT /F1 10 Tf 0 0 Td (Stamp) Tj ET';
      const resolver = formResolver({ Fm1: { streamId: 1, bytes: encode(formSrc) } });
      const first = parseContentStreams([encode('/Fm1 Do')], resolver);
      const second = parseContentStreams([encode('/Fm1 Do')], resolver);

      expect(first[0].editable).toBe(true);
      expect(second[0].editable).toBe(true);
    });
  });

  describe('image ops (Do sink)', () => {
    it('reports the CTM for an image drawn under cm, even with no resolveForm at all', () => {
      const src = '2 0 0 2 50 50 cm /Im1 Do';
      const bytes = encode(src);
      const ops: LocatedImageOp[] = [];
      const runs = parseContentStreams([bytes], undefined, (op) => ops.push(op));

      // The sink is a side channel: Do never produces a LocatedRun.
      expect(runs).toHaveLength(0);
      expect(ops).toHaveLength(1);
      expect(ops[0].streamIndex).toBe(0);
      expect(ops[0].name).toBe('Im1');
      expect(ops[0].ctm).toEqual([2, 0, 0, 2, 50, 50]);
      // start is the name token's start, end is just past the operator token.
      expect(decode(bytes.slice(ops[0].start, ops[0].end))).toBe('/Im1 Do');
    });

    it('reports the CTM in effect inside q/Q, and does not leak it to a Do afterward', () => {
      const src = 'q 3 0 0 3 10 10 cm /Im1 Do Q /Im2 Do';
      const ops: LocatedImageOp[] = [];
      parseContentStreams(
        [encode(src)],
        () => undefined,
        (op) => ops.push(op),
      );

      expect(ops).toHaveLength(2);
      expect(ops[0].name).toBe('Im1');
      expect(ops[0].ctm).toEqual([3, 0, 0, 3, 10, 10]);
      // Q restored the identity CTM saved before q, so Im2 sees it undisturbed.
      expect(ops[1].name).toBe('Im2');
      expect(ops[1].ctm).toEqual([1, 0, 0, 1, 0, 0]);
    });

    it('reports the CTM for an image inside a Form XObject, composing the form Matrix', () => {
      const formSrc = '/Im1 Do';
      const resolver = formResolver({
        Fm1: { streamId: 1, bytes: encode(formSrc), matrix: [2, 0, 0, 2, 100, 200] },
      });
      const ops: LocatedImageOp[] = [];
      parseContentStreams([encode('q 1 0 0 1 5 5 cm /Fm1 Do Q')], resolver, (op) => ops.push(op));

      expect(ops).toHaveLength(1);
      // Page ctm at the Do is [1 0 0 1 5 5]; composed with the form's own
      // Matrix (a form invocation is `q Matrix cm ... Q`, 8.10.2):
      // [2 0 0 2 100 200] x [1 0 0 1 5 5] = [2 0 0 2 105 205].
      expect(ops[0].streamIndex).toBe(1); // the resolver's assigned form id
      expect(ops[0].name).toBe('Im1');
      expect(ops[0].ctm).toEqual([2, 0, 0, 2, 105, 205]);
    });

    it('does not fire the sink for a Do that resolves to a form', () => {
      const resolver = formResolver({ Fm1: { streamId: 1, bytes: encode('') } });
      const ops: LocatedImageOp[] = [];
      parseContentStreams([encode('/Fm1 Do')], resolver, (op) => ops.push(op));

      expect(ops).toHaveLength(0);
    });
  });
});

describe('spliceOperatorBytes', () => {
  /** Offsets of `/Im1 Do` within `src`, as the parser reports them for a Do. */
  const doRange = (src: string): [number, number] => {
    const start = src.indexOf('/Im1');
    return [start, src.indexOf('Do', start) + 2];
  };

  const spliceDo = (src: string, replacement: string) => {
    const [start, end] = doRange(src);
    return decode(spliceOperatorBytes(encode(src), start, end, encode(replacement)));
  };

  it('leaves a well-separated operator alone, adding no padding', () => {
    expect(spliceDo('q 1 0 0 1 0 0 cm /Im1 Do Q', '/Im2 Do')).toBe('q 1 0 0 1 0 0 cm /Im2 Do Q');
  });

  it('does not glue the replacement to a preceding operator with no whitespace', () => {
    // `/` is self-delimiting, so `Q/Im1 Do` is legal PDF a writer can emit.
    // A raw splice of a replacement starting with `q` would produce `Qq`.
    const out = spliceDo('Q/Im1 Do', 'q 2 0 0 2 0 0 cm /Im1 Do Q');
    expect(out).toBe('Q q 2 0 0 2 0 0 cm /Im1 Do Q');
    expect(out).not.toContain('Qq');
  });

  it('does not glue the replacement to a following token with no whitespace', () => {
    const src = '/Im1 Do0 0 1 RG';
    const [start, end] = [src.indexOf('/Im1'), src.indexOf('Do') + 2];
    const out = decode(spliceOperatorBytes(encode(src), start, end, encode('q 1 0 0 1 0 0 cm /Im1 Do Q')));
    expect(out).toBe('q 1 0 0 1 0 0 cm /Im1 Do Q 0 0 1 RG');
    expect(out).not.toContain('Q0');
  });

  it('needs no padding when the replacement itself starts with a delimiter', () => {
    // `/` is a delimiter, so it separates from the preceding `Q` on its own.
    expect(spliceDo('Q/Im1 Do', '/Im2 Do')).toBe('Q/Im2 Do');
  });

  it('falls back to gap-closing removal for an empty replacement', () => {
    expect(spliceDo('q /Im1 Do Q', '')).toBe('q  Q');
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

/**
 * A FormResolver backed by a plain name->form map, standing in for mutate.ts's
 * real one (which walks pdf-lib's Resources/XObject dictionaries). Good
 * enough for these tests: they only care about the descent and matrix
 * composition, not the object model (see contentStream.ts's file header).
 */
function formResolver(forms: Record<string, ResolvedForm>): FormResolver {
  return (name) => forms[name];
}
