// @vitest-environment node
import {
  PDFArray,
  type PDFContext,
  type PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFRef,
  PDFString,
} from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { combinePdfs } from './combineDocuments';

/**
 * Named destinations as a reader resolves them, which is the only test that
 * counts for a link: these run the combined bytes through PDF.js, Folio's own
 * reader, and follow each link the way the viewer does (the link's decoded
 * name handed to `getDestination`). pdf-lib-level checks of the same code are
 * in combineStructure.test.ts; they cannot see a name that is byte-different
 * and reader-identical, which is what several of these are about.
 *
 * Node environment: PDF.js parses on its in-process fake worker, with no
 * canvas, since nothing is rendered.
 */

/**
 * A two-page input. `key` names its second page in the `/Names` `/Dests` name
 * tree; `link` is what the link on its first page asks for, as a `/Dest` or,
 * with `action`, as a `/GoTo` action's `/D`.
 */
async function input(key?: PDFObject, link?: PDFObject, action = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const first = doc.addPage([300, 300]);
  const second = doc.addPage([300, 300]);
  const ctx = doc.context;
  if (key instanceof PDFName) {
    // A name object is a key of the older catalog /Dests dictionary.
    const dests = ctx.obj({});
    dests.set(key, ctx.obj([second.ref, PDFName.of('Fit')]));
    doc.catalog.set(PDFName.of('Dests'), dests);
  } else if (key) {
    const names = ctx.obj({ Names: [key, [second.ref, PDFName.of('Fit')]] });
    doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: names }));
  }
  if (link) {
    const target = action ? { A: { S: 'GoTo', D: link } } : { Dest: link };
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], ...target });
    first.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  }
  return doc.save();
}

/**
 * An input with several destinations in one name tree. For N keys it has 2N
 * pages: page i carries the link that asks for key i, and page N + i is where
 * key i points. Keys are given in byte order, as a name tree requires.
 */
async function inputWithKeys(keys: PDFObject[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages = Array.from({ length: keys.length * 2 }, () => doc.addPage([300, 300]));
  const ctx = doc.context;
  const names = ctx.obj([]);
  keys.forEach((key, i) => {
    names.push(key);
    names.push(ctx.obj([pages[keys.length + i].ref, PDFName.of('Fit')]));
    const annot = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 30], Dest: key });
    pages[i].node.set(PDFName.of('Annots'), ctx.obj([ctx.register(annot)]));
  });
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: { Names: names } }));
  return doc.save();
}

/**
 * Where each link in `bytes` lands when PDF.js follows it: the 0-based page
 * index, or null for a link that resolves to nothing. One entry per page that
 * has a link, in page order.
 */
async function linkTargets(bytes: Uint8Array): Promise<Array<number | null>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const targets: Array<number | null> = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const annotations = await (await pdf.getPage(pageNumber)).getAnnotations();
      const link = annotations.find((annotation) => annotation.subtype === 'Link');
      if (!link) continue;
      const dest: unknown =
        typeof link.dest === 'string' ? await pdf.getDestination(link.dest) : link.dest;
      targets.push(Array.isArray(dest) ? await pdf.getPageIndex(dest[0]) : null);
    }
    return targets;
  } finally {
    await task.destroy();
  }
}

async function combinedTargets(...inputs: Uint8Array[]): Promise<Array<number | null>> {
  const { bytes } = await combinePdfs(
    inputs.map((data, index) => ({ name: `in${index}.pdf`, bytes: data })),
  );
  return linkTargets(bytes);
}

const ascii = () => PDFString.of('intro');
/** The same five letters as UTF-16BE with a byte-order mark. */
const utf16 = () => PDFHexString.of('FEFF0069006E00740072006F');

describe('named destinations, as PDF.js resolves them', () => {
  it('follows every link to its own file when both files use the same name', async () => {
    const one = await input(ascii(), ascii());
    expect(await linkTargets(one)).toEqual([1]);
    expect(await combinedTargets(one, await input(ascii(), ascii()))).toEqual([1, 3]);
  });

  it('follows a renamed GoTo action', async () => {
    const make = () => input(ascii(), ascii(), true);
    expect(await combinedTargets(await make(), await make())).toEqual([1, 3]);
  });

  // The same name written two ways is one name to a reader, which decodes
  // before it compares. Told apart by their bytes, both were kept, and the
  // second file's link landed in the first file.
  it('treats one name in two encodings as a clash', async () => {
    const plain = await input(ascii(), ascii());
    const wide = await input(utf16(), utf16());
    expect(await linkTargets(wide)).toEqual([1]);
    expect(await combinedTargets(plain, wide)).toEqual([1, 3]);
    expect(await combinedTargets(wide, plain)).toEqual([1, 3]);
  });

  // A suffix has to be encoded like the name it is added to. ASCII digits
  // appended to UTF-16 bytes pair up into other characters, and ~10 and ~11
  // decoded to the same one.
  it('keeps eleven copies of a UTF-16 name apart', async () => {
    const copies = await Promise.all(Array.from({ length: 11 }, () => input(utf16(), utf16())));
    expect(await combinedTargets(...copies)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  });

  // Each of these is a legal way to write the name, and the link finds it in
  // the input on its own. Combined with a file that has no names at all, it
  // has to go on finding it.
  it.each([
    ['white space inside a hex string', () => PDFHexString.of('69 6e74726f'), ascii],
    [
      'an odd number of hex digits',
      () => PDFHexString.of('696e74726f7'),
      () => PDFString.of('introp'),
    ],
    ['a backslash-newline continuation', () => PDFString.of('in\\\r\ntro'), ascii],
    ['an octal escape', () => PDFString.of('in\\164ro'), ascii],
    ['a literal key and a hex link', ascii, () => PDFHexString.of('696E74726F')],
    [
      'a non-ASCII name in PDFDocEncoding',
      () => PDFHexString.of('636166E9'),
      () => PDFHexString.of('636166E9'),
    ],
  ])('still resolves a name written with %s', async (_spelling, key, link) => {
    const one = await input(key(), link());
    expect(await linkTargets(one)).toEqual([1]);
    expect(await combinedTargets(one, await input())).toEqual([1]);
    expect(await combinedTargets(await input(), one)).toEqual([3]);
  });

  // A name object and a string are one name to the reader when they decode
  // alike: the legacy key /x#80 and the tree key <7880> are both "x" followed
  // by a bullet. Each file's link has to stay in its own file.
  it('treats a legacy name and a string that decode alike as a clash', async () => {
    const legacy = () => input(PDFName.of('x#80'), PDFName.of('x#80'));
    const tree = () => input(PDFHexString.of('7880'), PDFHexString.of('7880'));
    expect(await linkTargets(await legacy())).toEqual([1]);
    expect(await linkTargets(await tree())).toEqual([1]);
    expect(await combinedTargets(await legacy(), await tree())).toEqual([1, 3]);
    expect(await combinedTargets(await tree(), await legacy())).toEqual([1, 3]);
    expect(await combinedTargets(await legacy(), await legacy())).toEqual([1, 3]);
  });

  // Two keys of ONE file that decode alike are still two destinations. The
  // name tree orders and tells them apart by their bytes, so neither is a
  // duplicate of the other, and each link keeps the target its own key had.
  it.each([
    ['a PDFDocEncoding and a UTF-16 spelling', '7880', 'FEFF00782022'],
    // pdf-lib decodes the undefined byte AD as U+FFFD; PDF.js keeps it.
    ['a byte PDF.js and pdf-lib decode differently', '78AD', 'FEFF0078FFFD'],
  ])('keeps both destinations of one file under %s', async (_case, first, second) => {
    const one = await inputWithKeys([PDFHexString.of(first), PDFHexString.of(second)]);
    expect(await combinedTargets(one, await input())).toEqual([2, 3]);
    expect(await combinedTargets(await input(), one)).toEqual([4, 5]);
  });

  it('follows a link whose name is 200,000 bytes long', async () => {
    const long = () => PDFString.of('a'.repeat(200_000));
    const one = await input(long(), long());
    expect(await combinedTargets(one, await input())).toEqual([1]);
  });

  // A file split out of a larger one keeps links to names it no longer
  // defines. They were dead in that file and stay dead, whichever side of the
  // file that does define the name it is combined on.
  it('does not let a link to an undefined name resolve into another file', async () => {
    const dangling = () => input(undefined, ascii());
    const defining = () => input(ascii(), ascii());
    expect(await linkTargets(await dangling())).toEqual([null]);
    expect(await combinedTargets(await dangling(), await defining())).toEqual([null, 3]);
    expect(await combinedTargets(await defining(), await dangling())).toEqual([1, null]);
    // In another encoding too: the reader would have matched it by its text.
    expect(await combinedTargets(await input(undefined, utf16()), await defining())).toEqual([
      null,
      3,
    ]);
  });
});

/** A bookmark to build: its title, where it jumps (given the input's two page refs), and its children. */
interface Bookmark {
  title: string;
  dest: (pages: [PDFRef, PDFRef]) => PDFObject | PDFObject[];
  bold?: boolean;
  italic?: boolean;
  open?: boolean;
  kids?: Bookmark[];
}

/** Register `marks` as a linked sibling list under `parent`, returning its first and last ref. */
function linkBookmarks(
  ctx: PDFContext,
  marks: Bookmark[],
  parent: PDFRef,
  pages: [PDFRef, PDFRef],
): [PDFRef, PDFRef] {
  const dicts = marks.map((mark) => {
    const dict = ctx.obj({ Title: PDFString.of(mark.title) });
    const dest = mark.dest(pages);
    dict.set(PDFName.of('Dest'), Array.isArray(dest) ? ctx.obj(dest) : dest);
    const flags = (mark.italic ? 1 : 0) | (mark.bold ? 2 : 0);
    if (flags) dict.set(PDFName.of('F'), PDFNumber.of(flags));
    return dict;
  });
  const refs = dicts.map((dict) => ctx.register(dict));
  marks.forEach((mark, i) => {
    dicts[i].set(PDFName.of('Parent'), parent);
    if (i > 0) dicts[i].set(PDFName.of('Prev'), refs[i - 1]);
    if (i + 1 < marks.length) dicts[i].set(PDFName.of('Next'), refs[i + 1]);
    const kids = mark.kids ?? [];
    if (kids.length === 0) return;
    const [first, last] = linkBookmarks(ctx, kids, refs[i], pages);
    dicts[i].set(PDFName.of('First'), first);
    dicts[i].set(PDFName.of('Last'), last);
    dicts[i].set(PDFName.of('Count'), PDFNumber.of(mark.open ? kids.length : -kids.length));
  });
  return [refs[0], refs[refs.length - 1]];
}

/**
 * A two-page input with `marks` as its outline. `key` names its second page in
 * the name tree, for a bookmark that jumps by name.
 */
async function bookmarked(marks: Bookmark[], key?: PDFObject): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages: [PDFRef, PDFRef] = [doc.addPage([300, 300]).ref, doc.addPage([300, 300]).ref];
  const ctx = doc.context;
  if (key) {
    const names = ctx.obj({ Names: [key, [pages[1], PDFName.of('Fit')]] });
    doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: names }));
  }
  const root: PDFDict = ctx.obj({ Type: 'Outlines' });
  const rootRef = ctx.register(root);
  const [first, last] = linkBookmarks(ctx, marks, rootRef, pages);
  root.set(PDFName.of('First'), first);
  root.set(PDFName.of('Last'), last);
  root.set(PDFName.of('Count'), PDFNumber.of(marks.length));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  return doc.save();
}

const toPage = (index: 0 | 1) => (pages: [PDFRef, PDFRef]) => [pages[index], PDFName.of('Fit')];

interface ResolvedBookmark {
  title: string;
  /** The 0-based page the bookmark lands on, or null when it resolves to nothing. */
  page: number | null;
  bold: boolean;
  italic: boolean;
  items: ResolvedBookmark[];
}

/** The outline of `bytes` as PDF.js reads it, each item followed the way the viewer does. */
async function outlineTargets(bytes: Uint8Array): Promise<ResolvedBookmark[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const resolve = async (
      items: Awaited<ReturnType<typeof pdf.getOutline>>,
    ): Promise<ResolvedBookmark[]> => {
      const resolved: ResolvedBookmark[] = [];
      for (const item of items ?? []) {
        const dest: unknown =
          typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        resolved.push({
          title: item.title,
          page: Array.isArray(dest) ? await pdf.getPageIndex(dest[0]) : null,
          bold: item.bold,
          italic: item.italic,
          items: await resolve(item.items),
        });
      }
      return resolved;
    };
    return await resolve(await pdf.getOutline());
  } finally {
    await task.destroy();
  }
}

async function combinedOutline(...inputs: Uint8Array[]): Promise<ResolvedBookmark[]> {
  const { bytes } = await combinePdfs(
    inputs.map((data, index) => ({ name: `in${index}.pdf`, bytes: data })),
  );
  return outlineTargets(bytes);
}

/** Titles and landing pages, which is all most of these cases are about. */
function landings(items: ResolvedBookmark[]): Array<[string, number | null]> {
  return items.map((item) => [item.title, item.page]);
}

/**
 * A two-page tagged input whose one bookmark has only `/SE`: no `/Dest` and
 * no `/A` unless `action` is given. `element` builds the structure it points
 * at and returns the element.
 */
async function taggedBookmark(
  element: (ctx: PDFContext, pages: [PDFRef, PDFRef], root: PDFRef) => PDFRef,
  action?: (ctx: PDFContext) => PDFObject,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pages: [PDFRef, PDFRef] = [doc.addPage([300, 300]).ref, doc.addPage([300, 300]).ref];
  const ctx = doc.context;
  const treeRoot = ctx.register(ctx.obj({ Type: 'StructTreeRoot' }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), treeRoot);
  doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  const se = element(ctx, pages, treeRoot);
  const item = ctx.obj({ Title: PDFString.of('tagged'), SE: se });
  if (action) item.set(PDFName.of('A'), action(ctx));
  const root: PDFDict = ctx.obj({ Type: 'Outlines' });
  const rootRef = ctx.register(root);
  const itemRef = ctx.register(item);
  item.set(PDFName.of('Parent'), rootRef);
  root.set(PDFName.of('First'), itemRef);
  root.set(PDFName.of('Last'), itemRef);
  root.set(PDFName.of('Count'), PDFNumber.of(1));
  doc.catalog.set(PDFName.of('Outlines'), rootRef);
  return doc.save();
}

/** A structure element: `/S /Sect`, a parent, and whatever else is given. */
function sect(ctx: PDFContext, parent: PDFRef, extra: Record<string, unknown> = {}): PDFRef {
  return ctx.register(ctx.obj({ Type: 'StructElem', S: 'Sect', P: parent, ...extra } as never));
}

describe('bookmarks, as PDF.js resolves them', () => {
  it('jumps each bookmark to a page of its own file', async () => {
    const make = (tag: string) =>
      bookmarked([
        { title: `${tag} first`, dest: toPage(0) },
        { title: `${tag} second`, dest: toPage(1) },
      ]);
    expect(landings(await outlineTargets(await make('A')))).toEqual([
      ['A first', 0],
      ['A second', 1],
    ]);
    expect(landings(await combinedOutline(await make('A'), await make('B')))).toEqual([
      ['A first', 0],
      ['A second', 1],
      ['B first', 2],
      ['B second', 3],
    ]);
  });

  it('brings nested items and bold and italic through', async () => {
    const a = await bookmarked([
      {
        title: 'Part',
        dest: toPage(0),
        open: true,
        bold: true,
        kids: [{ title: 'Chapter', dest: toPage(1), italic: true }],
      },
    ]);
    const b = await bookmarked([{ title: 'Other', dest: toPage(1), bold: true, italic: true }]);
    const out = await combinedOutline(a, b);
    expect(out.map((item) => [item.title, item.bold, item.italic])).toEqual([
      ['Part', true, false],
      ['Other', true, true],
    ]);
    expect(out[0].items.map((item) => [item.title, item.page, item.bold, item.italic])).toEqual([
      ['Chapter', 1, false, true],
    ]);
    expect(out[1].page).toBe(3);
  });

  // The later file's name is renamed on the way in, and its bookmark has to go
  // with it, or it would land in the first file.
  it('lets a bookmark that jumps by name land in its own file when both define the name', async () => {
    const make = () => bookmarked([{ title: 'by name', dest: () => ascii() }], ascii());
    expect(landings(await outlineTargets(await make()))).toEqual([['by name', 1]]);
    expect(landings(await combinedOutline(await make(), await make()))).toEqual([
      ['by name', 1],
      ['by name', 3],
    ]);
  });

  // Tagged PDFs can point a bookmark at a structure element instead of a page.
  // PDF.js finds the page through the element's /Pg, a descendant's or an
  // ancestor's, and the rebuilt bookmark has to land on the same page.
  it.each([
    [
      'its own /Pg',
      (ctx: PDFContext, pages: [PDFRef, PDFRef], root: PDFRef) => sect(ctx, root, { Pg: pages[1] }),
    ],
    [
      'a child element',
      (ctx: PDFContext, pages: [PDFRef, PDFRef], root: PDFRef) => {
        const child = ctx.obj({ Type: 'StructElem', S: 'P', Pg: pages[1] });
        const se = sect(ctx, root, { K: [ctx.register(child)] });
        child.set(PDFName.of('P'), se);
        return se;
      },
    ],
    [
      'a marked-content reference two levels down',
      (ctx: PDFContext, pages: [PDFRef, PDFRef], root: PDFRef) => {
        const mcr = ctx.obj({ Type: 'MCR', Pg: pages[1], MCID: 0 });
        const middle = ctx.obj({ Type: 'StructElem', S: 'P', K: [mcr] });
        const se = sect(ctx, root, { K: ctx.register(middle) });
        middle.set(PDFName.of('P'), se);
        return se;
      },
    ],
    [
      'its parent',
      (ctx: PDFContext, pages: [PDFRef, PDFRef], root: PDFRef) => {
        const parent = sect(ctx, root, { Pg: pages[1] });
        return sect(ctx, parent);
      },
    ],
  ])('lands a bookmark that has only /SE where %s puts it', async (_where, element) => {
    const tagged = await taggedBookmark(element);
    expect(landings(await outlineTargets(tagged))).toEqual([['tagged', 1]]);
    const front = await bookmarked([{ title: 'front', dest: toPage(0) }]);
    expect(landings(await combinedOutline(front, tagged))).toEqual([
      ['front', 0],
      ['tagged', 3],
    ]);
  });

  it('does not let /SE give a web-link bookmark a page, or follow a page from another file', async () => {
    const link = await taggedBookmark(
      (ctx, pages, root) => sect(ctx, root, { Pg: pages[1] }),
      (ctx) => ctx.obj({ S: 'URI', URI: PDFString.of('https://example.com/') }),
    );
    const foreign = await taggedBookmark((ctx, _pages, root) => {
      const stray = ctx.register(ctx.obj({ Type: 'Page' }));
      return sect(ctx, root, { Pg: stray });
    });
    expect(landings(await combinedOutline(link, foreign))).toEqual([
      ['tagged', null],
      ['tagged', null],
    ]);
  });

  // PDF.js aims at the top left of the element's /BBox attribute.
  it('aims a /SE bookmark at the top left of the element box', async () => {
    const tagged = await taggedBookmark((ctx, pages, root) =>
      sect(ctx, root, { Pg: pages[1], A: { O: 'Layout', BBox: [40, 100, 200, 250] } }),
    );
    const { bytes } = await combinePdfs([
      { name: 'a.pdf', bytes: await input() },
      { name: 'b.pdf', bytes: tagged },
    ]);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true });
    const pdf = await task.promise;
    try {
      const [item] = (await pdf.getOutline()) ?? [];
      const dest = item?.dest;
      expect(Array.isArray(dest)).toBe(true);
      const [page, view, left, top, zoom] = dest as unknown[];
      expect(await pdf.getPageIndex(page as Parameters<typeof pdf.getPageIndex>[0])).toBe(3);
      expect([view, left, top, zoom]).toEqual([{ name: 'XYZ' }, 40, 250, null]);
    } finally {
      await task.destroy();
    }
  });

  // Every child shares the element's own child array, and no element names a
  // page, so the search has to give up. One that tracks elements but not
  // arrays re-reads that array once per child before it does: quadratic, and
  // 6,000 children took eight seconds in the renderer.
  it('reads a child array that many elements share only once', async () => {
    const shared = await taggedBookmark((ctx, _pages, root) => {
      const se = ctx.obj({ Type: 'StructElem', S: 'Sect', P: root });
      const seRef = ctx.register(se);
      const kids = ctx.obj([]);
      const kidsRef = ctx.register(kids);
      for (let i = 0; i < 6000; i++) {
        kids.push(ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: seRef, K: kidsRef })));
      }
      se.set(PDFName.of('K'), kidsRef);
      return seRef;
    });
    // Counted, not timed: array entries read during the combine. Read once,
    // the shared array costs about 6,000; read per child, 36 million. The
    // counter throws at its limit rather than recording every call, so a
    // regression fails at once instead of running for seconds.
    const LIMIT = 50_000;
    let reads = 0;
    const original = PDFArray.prototype.lookup;
    const counted = vi.spyOn(PDFArray.prototype, 'lookup').mockImplementation(function (
      this: PDFArray,
      ...args: Parameters<PDFArray['lookup']>
    ) {
      if (++reads > LIMIT) throw new Error(`more than ${LIMIT} array lookups`);
      return original.apply(this, args);
    } as PDFArray['lookup']);
    let bytes: Uint8Array;
    try {
      ({ bytes } = await combinePdfs([
        { name: 'a.pdf', bytes: await input() },
        { name: 'b.pdf', bytes: shared },
      ]));
    } finally {
      counted.mockRestore();
    }
    expect(reads).toBeLessThan(LIMIT);
    expect(landings(await outlineTargets(bytes))).toEqual([['tagged', null]]);
  });

  it('does not hang on a structure element that is its own child', async () => {
    const looped = await taggedBookmark((ctx, _pages, root) => {
      const se = ctx.obj({ Type: 'StructElem', S: 'Sect', P: root });
      const ref = ctx.register(se);
      se.set(PDFName.of('K'), ctx.obj([ref]));
      return ref;
    });
    expect(landings(await combinedOutline(looped, await input()))).toEqual([['tagged', null]]);
  });

  it('keeps a bookmark to a name its file never defines unresolved', async () => {
    const dangling = () => bookmarked([{ title: 'dangling', dest: () => ascii() }]);
    const defining = () => bookmarked([{ title: 'defining', dest: () => ascii() }], ascii());
    expect(landings(await outlineTargets(await dangling()))).toEqual([['dangling', null]]);
    expect(landings(await combinedOutline(await dangling(), await defining()))).toEqual([
      ['dangling', null],
      ['defining', 3],
    ]);
    expect(landings(await combinedOutline(await defining(), await dangling()))).toEqual([
      ['defining', 1],
      ['dangling', null],
    ]);
  });
});
