import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFString,
  type PDFContext,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { combinePdfs } from './combineDocuments';

/**
 * Structure-preservation probes for combinePdfs. Each `it.fails` documents a
 * confirmed gap (the assertion describes the desired behaviour and currently
 * fails); flip to `it` when the gap is fixed. The plain `it` cases pin what
 * does survive today.
 */

async function build(tag: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const p1 = doc.addPage([300, 300]);
  const p2 = doc.addPage([300, 300]);
  doc.setTitle(`Title ${tag}`);
  doc.setAuthor(`Author ${tag}`);
  const ctx = doc.context;

  // Outline: one root item pointing at page 2.
  const item = ctx.obj({
    Title: PDFString.of(`Bookmark ${tag}`),
    Dest: [p2.ref, PDFName.of('Fit')],
  });
  const itemRef = ctx.register(item);
  const outlines = ctx.obj({ Type: 'Outlines', First: itemRef, Last: itemRef, Count: 1 });
  const outlinesRef = ctx.register(outlines);
  item.set(PDFName.of('Parent'), outlinesRef);
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

  // Internal link annotation on page 1 to page 2 (explicit /Dest).
  const link = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 100, 30],
    Border: [0, 0, 0],
    Dest: [p2.ref, PDFName.of('Fit')],
  });
  p1.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(link)]));

  // Named destination + a GoTo link that uses the name. /Names /Dests is a
  // name tree, so the pairs sit in a /Names array. A plain dictionary keyed by
  // the name is not one, and no reader resolves it.
  const dests = ctx.obj({ Names: [PDFString.of(`dest_${tag}`), [p2.ref, PDFName.of('Fit')]] });
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: dests }));
  const namedLink = ctx.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 40, 100, 60],
    A: { S: 'GoTo', D: PDFString.of(`dest_${tag}`) },
  });
  (p1.node.get(PDFName.of('Annots')) as PDFArray).push(ctx.register(namedLink));

  // Page labels: roman numerals from the first page.
  doc.catalog.set(
    PDFName.of('PageLabels'),
    ctx.obj({ Nums: [PDFNumber.of(0), ctx.obj({ S: 'r' })] }),
  );

  // A form field with the SAME name in every input, with a value.
  const form = doc.getForm();
  const tf = form.createTextField('name');
  tf.setText(`value ${tag}`);
  tf.addToPage(p1, { x: 10, y: 200, width: 100, height: 20 });
  return doc.save();
}

/**
 * The page a named destination points at (as a ref string), found by walking
 * the catalog's /Names /Dests name tree: /Names pairs, and /Kids below them.
 */
function namedDestination(doc: PDFDocument, name: string): string | undefined {
  const walk = (node: PDFDict | undefined): string | undefined => {
    if (!node) return undefined;
    const pairs = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let i = 0; pairs && i + 1 < pairs.size(); i += 2) {
      const key = pairs.lookup(i);
      const isName = key instanceof PDFString || key instanceof PDFHexString;
      if (!isName || key.decodeText() !== name) continue;
      // The value is the destination array, or a dictionary holding it in /D.
      const value = pairs.lookup(i + 1);
      const dest = value instanceof PDFDict ? value.lookupMaybe(PDFName.of('D'), PDFArray) : value;
      return dest instanceof PDFArray ? dest.get(0)?.toString() : undefined;
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let i = 0; kids && i < kids.size(); i++) {
      const found = walk(kids.lookupMaybe(i, PDFDict));
      if (found) return found;
    }
    return undefined;
  };
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  return walk(names?.lookupMaybe(PDFName.of('Dests'), PDFDict));
}

async function combined() {
  const a = await build('A');
  const b = await build('B');
  const { bytes } = await combinePdfs([
    { name: 'a.pdf', bytes: a },
    { name: 'b.pdf', bytes: b },
  ]);
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/** What a named-destination fixture installs: a name tree root, a /Dests dict, a link. */
interface NamedSetup {
  names?: PDFObject;
  dests?: PDFObject;
  link?: Record<string, unknown>;
}

/**
 * A two-page input with whatever named destinations `setup` describes, plus
 * (when it gives one) a link annotation on page 1 carrying the given entries.
 */
async function buildNamed(
  setup: (ctx: PDFContext, pages: [PDFPage, PDFPage]) => NamedSetup,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages: [PDFPage, PDFPage] = [doc.addPage([300, 300]), doc.addPage([300, 300])];
  const ctx = doc.context;
  const { names, dests, link } = setup(ctx, pages);
  if (names) doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: names }));
  if (dests) doc.catalog.set(PDFName.of('Dests'), dests);
  if (link) {
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], ...link });
    pages[0].node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  }
  return doc.save();
}

/** An input of `count` blank pages whose /PageLabels is whatever `labels` returns, if given. */
async function buildLabelled(
  count: number,
  labels?: (ctx: PDFContext) => PDFObject,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < count; i++) doc.addPage([300, 300]);
  if (labels) doc.catalog.set(PDFName.of('PageLabels'), labels(doc.context));
  return doc.save();
}

/** The output's page-label ranges as [start index, label dictionary], in tree order. */
function labelRanges(doc: PDFDocument): Array<[number, PDFDict]> {
  const found: Array<[number, PDFDict]> = [];
  const walk = (node: PDFObject | undefined): void => {
    if (!(node instanceof PDFDict)) return;
    const nums = node.lookup(PDFName.of('Nums'));
    for (let i = 0; nums instanceof PDFArray && i + 1 < nums.size(); i += 2) {
      const index = nums.lookup(i);
      const label = nums.lookup(i + 1);
      if (index instanceof PDFNumber && label instanceof PDFDict) {
        found.push([index.asNumber(), label]);
      }
    }
    const kids = node.lookup(PDFName.of('Kids'));
    for (let i = 0; kids instanceof PDFArray && i < kids.size(); i++) walk(kids.lookup(i));
  };
  walk(doc.catalog.lookup(PDFName.of('PageLabels')));
  return found;
}

function roman(n: number, upper: boolean): string {
  const table: Array<[number, string]> = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let text = '';
  for (const [value, symbol] of table) {
    while (n >= value) {
      text += symbol;
      n -= value;
    }
  }
  return upper ? text.toUpperCase() : text;
}

/** A, B, ..., Z, AA, BB, ..., ZZ, AAA (PDF 12.4.2). */
function letters(n: number, upper: boolean): string {
  const letter = String.fromCharCode((upper ? 65 : 97) + ((n - 1) % 26));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}

/** The label every page of `doc` shows, computed from its /PageLabels per the spec. */
function pageLabels(doc: PDFDocument): string[] {
  const ranges = labelRanges(doc).sort((a, b) => a[0] - b[0]);
  return doc.getPages().map((_, page) => {
    let range: [number, PDFDict] | undefined;
    for (const candidate of ranges) if (candidate[0] <= page) range = candidate;
    if (!range) return String(page + 1);
    const [start, dict] = range;
    const prefix = dict.lookup(PDFName.of('P'));
    const startAt = dict.lookup(PDFName.of('St'));
    const number = (startAt instanceof PDFNumber ? startAt.asNumber() : 1) + (page - start);
    const style = textOf(dict.lookup(PDFName.of('S')));
    const numeric =
      style === 'D'
        ? String(number)
        : style === 'R' || style === 'r'
          ? roman(number, style === 'R')
          : style === 'A' || style === 'a'
            ? letters(number, style === 'A')
            : '';
    return textOf(prefix) + numeric;
  });
}

async function combineAll(...inputs: Uint8Array[]): Promise<PDFDocument> {
  const { bytes } = await combinePdfs(
    inputs.map((data, i) => ({ name: `in${i}.pdf`, bytes: data })),
  );
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/** The first annotation on an output page. */
function linkOf(doc: PDFDocument, pageIndex: number): PDFDict {
  return doc.getPage(pageIndex).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
}

/** Decoded text of a name, string or hex string; empty for anything else. */
function textOf(value: unknown): string {
  if (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return '';
}

describe('combinePdfs structure', () => {
  it('keeps only the first input metadata (documented behaviour)', async () => {
    const out = await combined();
    expect(out.getTitle()).toBe('Title A');
    expect(out.getAuthor()).toBe('Author A');
  });

  it('merges same-named form fields with their values and de-duplicates the name', async () => {
    const out = await combined();
    const fields = out.getForm().getFields();
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.getName()).sort()).toEqual(['name', 'name (2)']);
  });

  // GAP: the merged catalog is built from scratch; nothing copies /Outlines.
  it.fails('preserves document outlines (bookmarks) of every input', async () => {
    const out = await combined();
    expect(out.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)).toBeDefined();
  });

  it('preserves named destinations', async () => {
    const out = await combined();
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    expect(namedDestination(out, 'dest_A')).toBe(pageRefs[1]);
    expect(namedDestination(out, 'dest_B')).toBe(pageRefs[3]);
  });

  // Guards the fixture: if the name did not resolve in the input, the gap test
  // above would be failing for the wrong reason (it once did).
  it('builds inputs whose named destination resolves to their second page', async () => {
    const input = await PDFDocument.load(await build('A'), { updateMetadata: false });
    expect(namedDestination(input, 'dest_A')).toBe(input.getPage(1).ref.toString());
    expect(namedDestination(input, 'dest_B')).toBeUndefined();
  });

  it('preserves page labels', async () => {
    const out = await combined();
    expect(pageLabels(out)).toEqual(['i', 'ii', 'i', 'ii']);
  });

  it('restarts an unlabelled input at 1 after a labelled one', async () => {
    const out = await combineAll(await build('A'), await buildLabelled(2));
    expect(pageLabels(out)).toEqual(['i', 'ii', '1', '2']);
  });

  it('gives a labelled input its own labels after an unlabelled one', async () => {
    const out = await combineAll(await buildLabelled(2), await build('B'));
    expect(pageLabels(out)).toEqual(['1', '2', 'i', 'ii']);
  });

  // A file can parse and hold no pages at all. It has nothing to label, and its
  // offset is the next input's, so a range for it would put two entries at one
  // index of the number tree.
  it('gives a zero-page input no label range', async () => {
    // Buffer, not TextEncoder: under jsdom that hands back another realm's
    // Uint8Array, which pdf-lib's own instanceof check rejects.
    const empty = Uint8Array.from(
      Buffer.from(
        [
          '%PDF-1.7',
          // A comment line, so the file clears combine's minimum-size check.
          '% ' + 'padding '.repeat(60),
          '1 0 obj',
          '<< /Type /Catalog /Pages 2 0 R >>',
          'endobj',
          '2 0 obj',
          '<< /Type /Pages /Kids [] /Count 0 >>',
          'endobj',
          'trailer',
          '<< /Root 1 0 R /Size 3 >>',
          '%%EOF',
          '',
        ].join('\n'),
        'latin1',
      ),
    );
    expect((await PDFDocument.load(empty, { updateMetadata: false })).getPageCount()).toBe(0);
    const out = await combineAll(
      await buildLabelled(2, (ctx) => ctx.obj({ Nums: [0, { S: 'r' }] })),
      empty,
      await buildLabelled(2),
    );
    expect(labelRanges(out).map(([index]) => index)).toEqual([0, 2]);
    expect(pageLabels(out)).toEqual(['i', 'ii', '1', '2']);
  });

  it('writes no /PageLabels when no input has any', async () => {
    const out = await combineAll(await buildLabelled(2), await buildLabelled(3));
    expect(out.catalog.has(PDFName.of('PageLabels'))).toBe(false);
    expect(pageLabels(out)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('keeps a prefix and a start number', async () => {
    const a = await buildLabelled(2, (ctx) =>
      ctx.obj({ Nums: [0, { S: 'D', P: PDFString.of('A-'), St: 5 }] }),
    );
    const out = await combineAll(a, await buildLabelled(1));
    expect(pageLabels(out)).toEqual(['A-5', 'A-6', '1']);
  });

  it('keeps a prefix with parentheses and non-Latin text byte-exact', async () => {
    const prefix = PDFHexString.fromText('章 (a)\\');
    const a = await buildLabelled(2, (ctx) => ctx.obj({ Nums: [0, { S: 'D', P: prefix }] }));
    const out = await combineAll(await buildLabelled(1), a);
    expect(pageLabels(out)).toEqual(['1', '章 (a)\\1', '章 (a)\\2']);
    const written = labelRanges(out).find(([index]) => index === 1)?.[1];
    const bytes = written?.lookup(PDFName.of('P'));
    expect(bytes instanceof PDFHexString && Array.from(bytes.asBytes())).toEqual(
      Array.from(prefix.asBytes()),
    );
  });

  it('adds a decimal range at the first page of an input whose labels start later', async () => {
    const a = await buildLabelled(2, (ctx) => ctx.obj({ Nums: [1, { S: 'r' }] }));
    const out = await combineAll(await build('A'), a);
    expect(pageLabels(out)).toEqual(['i', 'ii', '1', 'i']);
  });

  it('reads a page-label tree that uses /Kids', async () => {
    const a = await buildLabelled(2, (ctx) => {
      const leaf = ctx.register(ctx.obj({ Nums: [0, { S: 'A' }] }));
      return ctx.obj({ Kids: [leaf] });
    });
    const out = await combineAll(a, await buildLabelled(2));
    expect(pageLabels(out)).toEqual(['A', 'B', '1', '2']);
  });

  it('splits more than 64 ranges into /Kids with ascending /Limits', async () => {
    const a = await buildLabelled(70, (ctx) => {
      const nums = PDFArray.withContext(ctx);
      // Reverse order in the input, so the output sort is what is being tested.
      for (let i = 69; i >= 0; i--) {
        nums.push(PDFNumber.of(i));
        nums.push(ctx.obj({ P: PDFString.of(`p${i}-`) }));
      }
      return ctx.obj({ Nums: nums });
    });
    const out = await combineAll(a, await buildLabelled(2));
    const root = out.catalog.lookup(PDFName.of('PageLabels'), PDFDict);
    expect(root.has(PDFName.of('Nums'))).toBe(false);
    const kids = root.lookup(PDFName.of('Kids'), PDFArray);
    expect(kids.size()).toBe(2);
    const limits: number[][] = [];
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i, PDFDict);
      const pair = kid.lookup(PDFName.of('Limits'), PDFArray);
      const nums = kid.lookup(PDFName.of('Nums'), PDFArray);
      const first = pair.lookup(0, PDFNumber).asNumber();
      const last = pair.lookup(1, PDFNumber).asNumber();
      expect(nums.lookup(0, PDFNumber).asNumber()).toBe(first);
      expect(nums.lookup(nums.size() - 2, PDFNumber).asNumber()).toBe(last);
      limits.push([first, last]);
    }
    expect(limits).toEqual([
      [0, 63],
      [64, 70],
    ]);
    const labels = pageLabels(out);
    expect(labels.slice(0, 3)).toEqual(['p0-', 'p1-', 'p2-']);
    expect(labels[69]).toBe('p69-');
    expect(labels.slice(70)).toEqual(['1', '2']);
  });

  it('survives malformed page-label trees and keeps the valid entries beside them', async () => {
    const n = PDFName.of;
    const out = await combineAll(
      // /PageLabels is a number.
      await buildLabelled(2, () => PDFNumber.of(3)),
      // Non-integer and out-of-range indices, non-dictionary values, one good pair.
      await buildLabelled(2, (ctx) =>
        ctx.obj({
          Nums: [
            PDFNumber.of(0.5),
            { S: 'a' },
            99,
            { S: 'a' },
            -1,
            { S: 'a' },
            1,
            5,
            0,
            { S: 'r' },
          ],
        }),
      ),
      // A kid that is a number, a kid that refers back to the root, a good pair.
      await buildLabelled(2, (ctx) => {
        const root = ctx.obj({ Nums: [1, { S: 'a' }] });
        const rootRef = ctx.register(root);
        root.set(n('Kids'), ctx.obj([7, rootRef]));
        return rootRef;
      }),
    );
    expect(pageLabels(out)).toEqual(['1', '2', 'i', 'ii', '1', 'a']);
  });

  it('turns an unknown style into decimal, and drops a non-integer start and a non-string prefix', async () => {
    const a = await buildLabelled(2, (ctx) =>
      ctx.obj({ Nums: [0, { S: 'Q', P: PDFString.of('x-'), St: 3, Junk: 1 }] }),
    );
    const b = await buildLabelled(2, (ctx) =>
      ctx.obj({ Nums: [0, { S: 'D', P: PDFNumber.of(7), St: PDFNumber.of(2.5) }] }),
    );
    const out = await combineAll(a, b);
    expect(pageLabels(out)).toEqual(['x-3', 'x-4', '1', '2']);
    const first = labelRanges(out)[0][1];
    expect(first.lookup(PDFName.of('S'))).toBe(PDFName.of('D'));
    expect(first.has(PDFName.of('Junk'))).toBe(false);
    expect(first.lookup(PDFName.of('St'), PDFNumber).asNumber()).toBe(3);
  });

  it('renames a colliding named destination and the later input link that uses it', async () => {
    const a = await buildNamed((ctx, pages) => ({
      names: ctx.obj({ Names: [PDFString.of('intro'), [pages[1].ref, PDFName.of('Fit')]] }),
      link: { A: { S: 'GoTo', D: PDFString.of('intro') } },
    }));
    const b = await buildNamed((ctx, pages) => ({
      names: ctx.obj({ Names: [PDFString.of('intro'), [pages[1].ref, PDFName.of('Fit')]] }),
      link: { A: { S: 'GoTo', D: PDFString.of('intro') } },
    }));
    const out = await combineAll(a, b);
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    expect(namedDestination(out, 'intro')).toBe(pageRefs[1]);
    expect(namedDestination(out, 'intro~2')).toBe(pageRefs[3]);
    const first = linkOf(out, 0).lookup(PDFName.of('A'), PDFDict);
    const second = linkOf(out, 2).lookup(PDFName.of('A'), PDFDict);
    expect(textOf(first.lookup(PDFName.of('D')))).toBe('intro');
    expect(textOf(second.lookup(PDFName.of('D')))).toBe('intro~2');
  });

  // A file split out of a larger one often keeps links to names it no longer
  // defines. They were dead in that file and must stay dead: left alone, the
  // other input's destination of the same name would capture them.
  it('keeps a link to an undefined name from resolving into another input', async () => {
    const dangling = () => buildNamed(() => ({ link: { Dest: PDFString.of('intro') } }));
    const defining = () =>
      buildNamed((ctx, pages) => ({
        names: ctx.obj({ Names: [PDFString.of('intro'), [pages[1].ref, PDFName.of('Fit')]] }),
        link: { Dest: PDFString.of('intro') },
      }));
    const target = (doc: PDFDocument, pageIndex: number) =>
      namedDestination(doc, textOf(linkOf(doc, pageIndex).lookup(PDFName.of('Dest'))));

    // The dangling file first: the name is defined only by a LATER input.
    const before = await combineAll(await dangling(), await defining());
    expect(target(before, 0)).toBeUndefined();
    expect(target(before, 2)).toBe(before.getPages()[3].ref.toString());

    // And second: the name is already defined by an earlier input.
    const after = await combineAll(await defining(), await dangling());
    expect(target(after, 0)).toBe(after.getPages()[1].ref.toString());
    expect(target(after, 2)).toBeUndefined();
  });

  it('keeps a dangling GoTo action dangling, and its orphan name out of reach', async () => {
    const dangling = await buildNamed(() => ({
      link: { A: { S: 'GoTo', D: PDFString.of('intro') } },
    }));
    // This input defines the very name the orphan would have been given.
    const squatter = await buildNamed((ctx, pages) => ({
      names: ctx.obj({
        Names: [
          PDFString.of('intro'),
          [pages[1].ref, PDFName.of('Fit')],
          PDFString.of('intro~0'),
          [pages[1].ref, PDFName.of('Fit')],
        ],
      }),
    }));
    const out = await combineAll(dangling, squatter);
    const action = linkOf(out, 0).lookup(PDFName.of('A'), PDFDict);
    expect(namedDestination(out, textOf(action.lookup(PDFName.of('D'))))).toBeUndefined();
    // Both of the second input's own names still resolve, to its own page.
    expect(namedDestination(out, 'intro')).toBe(out.getPages()[3].ref.toString());
  });

  // The older table is read, and its entries join the one name tree that is
  // written: a single table and a single namespace. The links that used a name
  // object become strings, which is what finds an entry of a name tree.
  it('moves the older catalog /Dests dictionary into the name tree, renaming on collision', async () => {
    const make = () =>
      buildNamed((ctx, pages) => ({
        dests: ctx.obj({ intro: [pages[1].ref, PDFName.of('Fit')] }),
        link: { Dest: PDFName.of('intro') },
      }));
    const out = await combineAll(await make(), await make());
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    expect(out.catalog.has(PDFName.of('Dests'))).toBe(false);
    expect(namedDestination(out, 'intro')).toBe(pageRefs[1]);
    expect(namedDestination(out, 'intro~2')).toBe(pageRefs[3]);
    for (const [pageIndex, name] of [
      [0, 'intro'],
      [2, 'intro~2'],
    ] as const) {
      const dest = linkOf(out, pageIndex).lookup(PDFName.of('Dest'));
      expect(dest).toBeInstanceOf(PDFHexString);
      expect(textOf(dest)).toBe(name);
    }
  });

  // Two keys of one file that decode to the same text are still two
  // destinations: by the name tree's own rules they are different keys. Each
  // keeps its target, under a name of its own, and each link follows its key.
  it('keeps two keys of one input that decode to the same text', async () => {
    const a = await buildNamed((ctx, pages) => ({
      names: ctx.obj({
        Names: [
          PDFHexString.of('7880'),
          [pages[0].ref, PDFName.of('Fit')],
          PDFHexString.of('FEFF00782022'),
          [pages[1].ref, PDFName.of('Fit')],
        ],
      }),
      link: { Dest: PDFHexString.of('FEFF00782022') },
    }));
    const out = await combineAll(a, await buildNamed(() => ({})));
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    const bullet = 'x\u2022';
    expect(namedDestination(out, bullet)).toBe(pageRefs[0]);
    expect(namedDestination(out, `${bullet}~2`)).toBe(pageRefs[1]);
    expect(textOf(linkOf(out, 0).lookup(PDFName.of('Dest')))).toBe(`${bullet}~2`);
  });

  // pdf-lib's decoders pass every character as a call argument. A name is as
  // long as its file allows, and one of 200,000 bytes overflowed the stack
  // and failed the whole combine.
  it('combines a file whose destination name is 200,000 bytes long', async () => {
    const long = 'a'.repeat(200_000);
    const a = await buildNamed((ctx, pages) => ({
      names: ctx.obj({ Names: [PDFString.of(long), [pages[1].ref, PDFName.of('Fit')]] }),
      link: { Dest: PDFString.of(long) },
    }));
    const out = await combineAll(a, await buildNamed(() => ({})));
    expect(out.getPageCount()).toBe(4);
    const dest = linkOf(out, 0).lookup(PDFName.of('Dest'));
    expect(dest).toBeInstanceOf(PDFHexString);
    // asString, not decodeText: pdf-lib's decoder is the one that overflows.
    expect((dest as PDFHexString).asString()).toBe('61'.repeat(200_000));
  });

  it('drops a destination that does not point at one of the input pages', async () => {
    const a = await buildNamed((ctx, pages) => {
      const notAPage = ctx.register(ctx.obj({ Type: 'Whatever' }));
      return {
        names: ctx.obj({
          Names: [
            PDFString.of('bad'),
            [notAPage, PDFName.of('Fit')],
            PDFString.of('good'),
            [pages[1].ref, PDFName.of('Fit')],
          ],
        }),
      };
    });
    const out = await combineAll(a, await build('B'));
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    expect(namedDestination(out, 'bad')).toBeUndefined();
    expect(namedDestination(out, 'good')).toBe(pageRefs[1]);
  });

  // The copier follows every reference it is handed, with no limit of its own.
  // A destination is rebuilt from its page and its plain operands, so whatever
  // an extra element points at is never walked: this input used to fail the
  // whole combine with a stack overflow.
  it('drops a destination with an extra element without walking what it points at', async () => {
    const a = await buildNamed((ctx, pages) => {
      let chain = ctx.register(ctx.obj({}));
      for (let i = 0; i < 2500; i++) chain = ctx.register(ctx.obj({ Next: chain }));
      return {
        names: ctx.obj({
          Names: [
            PDFString.of('deep'),
            [pages[1].ref, PDFName.of('Fit'), chain],
            PDFString.of('fine'),
            [pages[1].ref, PDFName.of('Fit')],
          ],
        }),
      };
    });
    const out = await combineAll(a, await build('B'));
    expect(namedDestination(out, 'deep')).toBeUndefined();
    expect(namedDestination(out, 'fine')).toBe(out.getPages()[1].ref.toString());
  });

  it('keeps a view and its operands, and refuses what the spec does not define', async () => {
    const a = await buildNamed((ctx, pages) => {
      const page = pages[1].ref;
      return {
        names: ctx.obj({
          Names: [
            PDFString.of('bare'),
            [page],
            PDFString.of('bogus'),
            [page, PDFName.of('Sideways')],
            PDFString.of('many'),
            [page, PDFName.of('FitR'), 1, 2, 3, 4, 5],
            PDFString.of('text'),
            [page, PDFName.of('FitH'), PDFString.of('x')],
            PDFString.of('wrapped'),
            { D: [page, PDFName.of('FitH'), 700] },
            PDFString.of('xyz'),
            [page, PDFName.of('XYZ'), 10, 20, null],
          ],
        }),
      };
    });
    const out = await combineAll(a, await buildNamed(() => ({})));
    const pairs = out.catalog
      .lookup(PDFName.of('Names'), PDFDict)
      .lookup(PDFName.of('Dests'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray);
    const views: Record<string, string> = {};
    for (let i = 0; i + 1 < pairs.size(); i += 2) {
      const [target, ...view] = pairs.lookup(i + 1, PDFArray).asArray();
      expect(target.toString()).toBe(out.getPages()[1].ref.toString());
      views[textOf(pairs.lookup(i))] = view.map((item) => item.toString()).join(' ');
    }
    expect(views).toEqual({
      bare: '/Fit',
      wrapped: '/FitH 700',
      xyz: '/XYZ 10 20 null',
    });
  });

  it('reads a name tree that is two levels of /Kids', async () => {
    const a = await buildNamed((ctx, pages) => {
      const leaf = ctx.register(
        ctx.obj({ Names: [PDFString.of('deep'), [pages[1].ref, PDFName.of('Fit')]] }),
      );
      const mid = ctx.register(ctx.obj({ Kids: [leaf] }));
      return { names: ctx.obj({ Kids: [mid] }) };
    });
    const out = await combineAll(a, await build('B'));
    expect(namedDestination(out, 'deep')).toBe(out.getPages()[1].ref.toString());
  });

  it('splits more than 64 destinations into sorted leaves with limits', async () => {
    const keys = Array.from({ length: 70 }, (_, i) => `k${String(i).padStart(3, '0')}`);
    const a = await buildNamed((ctx, pages) => {
      const flat = PDFArray.withContext(ctx);
      // Reverse order in the input, so the output sort is what is being tested.
      for (const key of [...keys].reverse()) {
        flat.push(PDFString.of(key));
        flat.push(ctx.obj([pages[1].ref, PDFName.of('Fit')]));
      }
      return { names: ctx.obj({ Names: flat }) };
    });
    const out = await combineAll(a, await buildNamed(() => ({})));
    const root = out.catalog
      .lookup(PDFName.of('Names'), PDFDict)
      .lookup(PDFName.of('Dests'), PDFDict);
    expect(root.has(PDFName.of('Names'))).toBe(false);
    const kids = root.lookup(PDFName.of('Kids'), PDFArray);
    expect(kids.size()).toBe(2);
    const seen: string[] = [];
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i, PDFDict);
      const limits = kid.lookup(PDFName.of('Limits'), PDFArray);
      const pairs = kid.lookup(PDFName.of('Names'), PDFArray);
      const names: string[] = [];
      for (let j = 0; j < pairs.size(); j += 2) names.push(textOf(pairs.lookup(j)));
      expect(textOf(limits.lookup(0))).toBe(names[0]);
      expect(textOf(limits.lookup(1))).toBe(names[names.length - 1]);
      seen.push(...names);
    }
    expect(seen).toEqual(keys.slice());
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    for (const key of keys) expect(namedDestination(out, key)).toBe(pageRefs[1]);
  });

  it('does not hang on a name tree whose kid refers back to the root', async () => {
    const a = await buildNamed((ctx, pages) => {
      const root = ctx.obj({ Names: [PDFString.of('loop'), [pages[1].ref, PDFName.of('Fit')]] });
      const rootRef = ctx.register(root);
      root.set(PDFName.of('Kids'), ctx.obj([rootRef]));
      return { names: rootRef };
    });
    const out = await combineAll(a, await build('B'));
    expect(namedDestination(out, 'loop')).toBe(out.getPages()[1].ref.toString());
  });

  // Carrying destinations is best-effort. Before it existed these files
  // combined fine, so a table that is not the shape the spec gives it costs
  // the input its named links and nothing else.
  it('ignores malformed destination tables instead of failing the combine', async () => {
    const n = PDFName.of;
    const malformed = async (mutate: (doc: PDFDocument, page2: PDFPage) => void) => {
      const doc = await PDFDocument.create({ updateMetadata: false });
      doc.addPage([300, 300]);
      const page2 = doc.addPage([300, 300]);
      mutate(doc, page2);
      return doc.save();
    };
    const out = await combineAll(
      // /Names and the older /Dests are numbers.
      await malformed((doc) => {
        doc.catalog.set(n('Names'), PDFNumber.of(3));
        doc.catalog.set(n('Dests'), PDFNumber.of(4));
      }),
      // /Names /Dests is an array.
      await malformed((doc) => doc.catalog.set(n('Names'), doc.context.obj({ Dests: [1, 2] }))),
      // A node whose /Names is a dictionary and whose /Kids holds a number,
      // next to one good leaf with a trailing key that has no value.
      await malformed((doc, page2) => {
        const good = doc.context.obj({
          Names: [PDFString.of('ok'), [page2.ref, n('Fit')], PDFString.of('odd')],
        });
        doc.catalog.set(n('Names'), doc.context.obj({ Dests: { Names: {}, Kids: [7, good] } }));
      }),
      // A key that is not a string, a value that is a number, a /D that is not an array.
      await malformed((doc, page2) => {
        const names = [
          5,
          [page2.ref, n('Fit')],
          PDFString.of('num'),
          9,
          PDFString.of('dict'),
          { D: 9 },
        ];
        doc.catalog.set(n('Names'), doc.context.obj({ Dests: { Names: names } }));
      }),
    );
    expect(out.getPageCount()).toBe(8);
    expect(namedDestination(out, 'ok')).toBe(out.getPages()[5].ref.toString());
    expect(namedDestination(out, 'odd')).toBeUndefined();
    expect(namedDestination(out, 'num')).toBeUndefined();
    expect(namedDestination(out, 'dict')).toBeUndefined();
  });

  it('renames a link whose action entries are the wrong type', async () => {
    const make = () =>
      buildNamed((ctx, pages) => ({
        names: ctx.obj({ Names: [PDFString.of('intro'), [pages[1].ref, PDFName.of('Fit')]] }),
        link: { Dest: PDFString.of('intro'), A: PDFNumber.of(1), AA: PDFNumber.of(2) },
      }));
    const out = await combineAll(await make(), await make());
    expect(textOf(linkOf(out, 0).lookup(PDFName.of('Dest')))).toBe('intro');
    expect(textOf(linkOf(out, 2).lookup(PDFName.of('Dest')))).toBe('intro~2');
  });

  // PDFName.of reads #xx in its argument as an escape, so the fixture escapes
  // the # itself. The name's own bytes are what is read, so it comes through
  // as "a#41" and not as "aA".
  it('keeps a literal # in an old-style destination name', async () => {
    const hash = PDFName.of('a#2341');
    expect(hash.decodeText()).toBe('a#41');
    const make = () =>
      buildNamed((ctx, pages) => {
        const dests = ctx.obj({});
        dests.set(hash, ctx.obj([pages[1].ref, PDFName.of('Fit')]));
        return { dests, link: { Dest: hash } };
      });
    const out = await combineAll(await make(), await make());
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    expect(namedDestination(out, 'a#41')).toBe(pageRefs[1]);
    expect(namedDestination(out, 'a#41~2')).toBe(pageRefs[3]);
    expect(namedDestination(out, 'aA')).toBeUndefined();
    expect(textOf(linkOf(out, 0).lookup(PDFName.of('Dest')))).toBe('a#41');
    expect(textOf(linkOf(out, 2).lookup(PDFName.of('Dest')))).toBe('a#41~2');
  });

  // Link annotations ride along with the page, and the copier follows /Dest
  // page refs, so an explicit /Dest should resolve to a page of the merged doc.
  it('keeps explicit-destination links pointing at the copied page', async () => {
    const out = await combined();
    const pageRefs = out.getPages().map((p) => p.ref.toString());
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    let found = false;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      const dest = a.lookupMaybe(PDFName.of('Dest'), PDFArray);
      if (dest) {
        found = true;
        expect(pageRefs).toContain(dest.get(0)!.toString());
      }
    }
    expect(found).toBe(true);
  });
});
