/**
 * Working out what address, if any, sits under a point on a page.
 *
 * Three sources, in priority order: a `/Link` annotation, an address printed in
 * the page's own text, and one in text recognised on a scan. The annotation is
 * what the document's author declared, so it wins: where they disagree, that is
 * what a click would follow, and the one worth putting on the clipboard.
 *
 * Hit-testing is done against PDF user-space geometry rather than the DOM. One
 * mechanism then covers every source, it does not depend on PDF.js having
 * rendered an anchor for a link (clicking one navigates nowhere in Folio, by
 * design), and it works the same in a test with no layout.
 */
// From the leaf module, not the @/core/pdf barrel: the barrel also re-exports
// getEngine, which pulls in pdf.js and its worker setup, and this module's
// whole reason for being testable with no layout is that it has no such
// dependency. type PageLink below is the same story.
import { HIT_PAD, itemBox, pickTextItem, type TextItemLike } from '@/core/pdf/textHit';
import type { PageLink } from '@/core/pdf/types';

import { addressAt, findAddresses, type AddressKind, type DetectedAddress } from './detect';

/**
 * How close two items have to sit before they are treated as one run of text.
 * A genuine address broken across items has no visual gap; a space between two
 * words does, and joining across one would invent addresses out of "visit" and
 * "example.com".
 */
const JOIN_GAP = 0.5;

export interface CopyTarget {
  kind: AddressKind;
  /** What goes on the clipboard. */
  value: string;
  /**
   * Where it came from. An `annotation` target is the document's own declared
   * link, which may not match the words printed over it; `ocr` is text Folio
   * recognised itself on a scanned page.
   */
  source: 'annotation' | 'text' | 'ocr';
}

/** A target plus the box it occupies, in PDF user space, for the hover hint. */
export interface ResolvedTarget {
  target: CopyTarget;
  rect: [number, number, number, number];
}

/** The smallest link rect containing the point. */
export function pickLink(links: readonly PageLink[], x: number, y: number): PageLink | null {
  let best: PageLink | null = null;
  let bestArea = Infinity;

  for (const link of links) {
    // A /Rect is allowed to name its corners in either order.
    const x0 = Math.min(link.rect[0], link.rect[2]);
    const y0 = Math.min(link.rect[1], link.rect[3]);
    const x1 = Math.max(link.rect[0], link.rect[2]);
    const y1 = Math.max(link.rect[1], link.rect[3]);
    if (x < x0 - HIT_PAD || x > x1 + HIT_PAD || y < y0 - HIT_PAD || y > y1 + HIT_PAD) continue;

    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      best = link;
      bestArea = area;
    }
  }

  return best;
}

/** A link annotation as something to copy. */
export function targetFromLink(link: PageLink): CopyTarget {
  const mail = /^mailto:/i.exec(link.url);
  if (!mail) return { kind: 'url', value: link.url, source: 'annotation' };

  // RFC 6068: everything from the first `?` is headers (subject, body, cc...),
  // not part of the address, and a mailto may name several recipients
  // separated by commas -- "Copy email address" means only the first of them.
  const recipient = link.url.slice(mail[0].length).split('?')[0].split(',')[0];
  let decoded = recipient;
  try {
    decoded = decodeURIComponent(recipient);
  } catch {
    // An invalid escape leaves the recipient exactly as printed.
  }

  const found = findAddresses(decoded)[0];
  // Anything that does not decode to a bare address is not worth labelling
  // "email": fall back to the raw target, the same as any other link.
  return found?.kind === 'email' && found.value === decoded
    ? { kind: 'email', value: found.value, source: 'annotation' }
    : { kind: 'url', value: link.url, source: 'annotation' };
}

/** An address printed in the page text, under the point. */
export function targetFromText(
  items: readonly TextItemLike[],
  x: number,
  y: number,
): ResolvedTarget | null {
  const index = pickTextItem(items, x, y);
  if (index < 0) return null;

  // Always scan the whole run rather than the item on its own. PDF.js splits at
  // every font or spacing change, so "owen@example.com" can arrive as "owen@"
  // plus "example.com" -- and the tail reads as a perfectly good web address by
  // itself, so an item-first scan would confidently copy half of an email.
  const item = items[index];
  const run = joinRun(items, index);

  // The point has to land ON an address, not merely share a line (or a joined
  // run) with one. PDF.js usually emits one item per line, so without this a
  // whole paragraph containing exactly one address anywhere in it would offer
  // to copy that address from wherever the pointer happened to be.
  const offset = pointToOffset(run, item, x);
  const address = addressAt(run.text, offset);
  if (!address) return null;

  return {
    target: { kind: address.kind, value: address.value, source: 'text' },
    rect: addressRect(run, address),
  };
}

/** Where the point falls along the item, as a character offset into the run's text. */
function pointToOffset(run: Run, item: TextItemLike, x: number): number {
  const [x0, , x1] = itemBox(item);
  const across = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
  // Characters are not evenly spaced, so this is only ever a character or two
  // out -- enough to land inside the right address when an item holds more
  // than one, not enough to land inside the wrong one.
  return run.start + Math.round(across * item.str.length);
}

interface RunPart {
  item: TextItemLike;
  /** Where this item's text begins in the run's text. */
  from: number;
  to: number;
}

interface Run {
  text: string;
  parts: RunPart[];
  /** The span of the item the point actually landed on. */
  start: number;
  end: number;
}

/**
 * The box an address occupies, rather than the whole line it sits on.
 *
 * Character advances are not available per glyph, so the address's span is
 * mapped across each item it covers in proportion to its characters. That is an
 * approximation, but only ever for where a highlight is drawn: which address
 * was matched is already settled by the time this runs.
 */
function addressRect(run: Run, address: DetectedAddress): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;

  for (const part of run.parts) {
    if (part.to <= address.start || part.from >= address.end) continue;
    const [px0, py0, px1, py1] = itemBox(part.item);
    const chars = part.to - part.from;
    const width = px1 - px0;
    const startFraction = chars > 0 ? Math.max(0, address.start - part.from) / chars : 0;
    const endFraction = chars > 0 ? Math.min(chars, address.end - part.from) / chars : 1;

    x0 = Math.min(x0, px0 + width * startFraction);
    x1 = Math.max(x1, px0 + width * endFraction);
    y0 = Math.min(y0, py0);
    y1 = Math.max(y1, py1);
  }

  return [x0, y0, x1, y1];
}

/**
 * The item joined with the neighbours it visually touches, and where the item
 * itself sits in the result. An item with no touching neighbour is its own run.
 */
function joinRun(items: readonly TextItemLike[], index: number): Run {
  let first = index;
  while (first > 0 && adjacent(items[first - 1], items[first])) first -= 1;

  let last = index;
  while (last + 1 < items.length && adjacent(items[last], items[last + 1])) last += 1;

  const parts: RunPart[] = [];
  let text = '';
  for (let i = first; i <= last; i += 1) {
    const from = text.length;
    text += items[i].str;
    parts.push({ item: items[i], from, to: text.length });
  }

  const hit = parts[index - first];
  return { text, parts, start: hit.from, end: hit.to };
}

/** A recognised word and where it sits, as fractions of the displayed page. */
export interface OcrWordLike {
  text: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** A target plus the box it occupies, as fractions of the displayed page. */
export interface ResolvedOcrTarget {
  target: CopyTarget;
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * An address in text Folio recognised itself on a scanned page.
 *
 * OCR results live in their own sidecar, keyed to the document rather than
 * written into it, so nothing in the PDF's own text content sees them until
 * they are baked into a saved copy. Without this source, right-clicking an
 * address on a freshly recognised scan would find nothing at all, which is the
 * one case a reader most wants it in.
 *
 * Words are matched whole. A recogniser splits on whitespace, so an address is
 * a single word, and joining neighbours the way the text path does would only
 * invent ones out of adjacent words.
 */
export function targetFromOcr(
  words: readonly OcrWordLike[],
  nx: number,
  ny: number,
): ResolvedOcrTarget | null {
  let best: ResolvedOcrTarget | null = null;
  let bestArea = Infinity;

  for (const word of words) {
    const { x, y, width, height } = word.rect;
    if (nx < x || nx > x + width || ny < y || ny > y + height) continue;

    const found = findAddresses(word.text);
    if (found.length !== 1) continue;

    const area = width * height;
    if (area >= bestArea) continue;
    best = {
      target: { kind: found[0].kind, value: found[0].value, source: 'ocr' },
      rect: word.rect,
    };
    bestArea = area;
  }

  return best;
}

/** Whether `right` carries straight on from `left`, with no gap and no line break. */
function adjacent(left: TextItemLike, right: TextItemLike): boolean {
  if (!left.str || !right.str) return false;
  const [, leftBottom, leftRight, leftTop] = itemBox(left);
  const [rightLeft, rightBottom, , rightTop] = itemBox(right);
  // Same line: the boxes have to overlap vertically.
  if (rightTop < leftBottom || rightBottom > leftTop) return false;
  return Math.abs(rightLeft - leftRight) <= JOIN_GAP;
}
