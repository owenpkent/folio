/**
 * Working out what address, if any, sits under a point on a page.
 *
 * Two sources, in priority order. A `/Link` annotation is what the document's
 * author declared, so it wins over anything spotted in the text: if the two
 * disagree, the annotation is what a click would actually follow, and it is the
 * one worth putting on the clipboard.
 *
 * Hit-testing is done against PDF user-space geometry rather than the DOM. The
 * annotation layer is `pointer-events: none` between form fields, so an anchor
 * PDF.js rendered for a link never receives the event, and going through the
 * geometry works the same in a test with no layout.
 */
import type { PageLink } from '@/core/pdf/types';

import { addressAt, findAddresses, type AddressKind, type DetectedAddress } from './detect';

/**
 * Slack around a box, in PDF units, so a right-click near an address still
 * finds it. Mirrors the allowance textedit's own hit test uses.
 */
const HIT_PAD = 2;

/**
 * How close two items have to sit before they are treated as one run of text.
 * A genuine address broken across items has no visual gap; a space between two
 * words does, and joining across one would invent addresses out of "visit" and
 * "example.com".
 */
const JOIN_GAP = 0.5;

/** The parts of a PDF.js text item this needs, named so tests can build one. */
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface CopyTarget {
  kind: AddressKind;
  /** What goes on the clipboard. */
  value: string;
  /**
   * Where it came from. An `annotation` target is the document's own declared
   * link, which may not match the words printed over it.
   */
  source: 'annotation' | 'text';
}

/**
 * The item's box in PDF user space, `[x0, y0, x1, y1]`. The allowance below the
 * baseline covers descenders without inflating the box enough for neighbouring
 * lines to overlap. Same shape textedit uses, deliberately.
 */
export function itemBox(item: TextItemLike): [number, number, number, number] {
  const x = item.transform[4];
  const y = item.transform[5];
  return [x, y - 0.2 * item.height, x + item.width, y + item.height];
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
  return mail
    ? { kind: 'email', value: link.url.slice(mail[0].length), source: 'annotation' }
    : { kind: 'url', value: link.url, source: 'annotation' };
}

/** The index of the smallest item box containing the point. */
export function pickTextItem(items: readonly TextItemLike[], x: number, y: number): number {
  let best = -1;
  let bestArea = Infinity;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.str) continue;
    const [x0, y0, x1, y1] = itemBox(item);
    if (x < x0 - HIT_PAD || x > x1 + HIT_PAD || y < y0 - HIT_PAD || y > y1 + HIT_PAD) continue;

    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) {
      best = index;
      bestArea = area;
    }
  }

  return best;
}

/** An address printed in the page text, under the point. */
export function targetFromText(
  items: readonly TextItemLike[],
  x: number,
  y: number,
): CopyTarget | null {
  const index = pickTextItem(items, x, y);
  if (index < 0) return null;

  // Always scan the whole run rather than the item on its own. PDF.js splits at
  // every font or spacing change, so "owen@example.com" can arrive as "owen@"
  // plus "example.com" -- and the tail reads as a perfectly good web address by
  // itself, so an item-first scan would confidently copy half of an email.
  const item = items[index];
  const run = joinRun(items, index);

  const found = findAddresses(run.text).filter(
    (address) => address.end > run.start && address.start < run.end,
  );
  if (found.length === 0) return null;

  const address = found.length === 1 ? found[0] : nearest(found, run, item, x);
  return { kind: address.kind, value: address.value, source: 'text' };
}

/** Whichever of several addresses the point fell nearest, along the item. */
function nearest(
  found: readonly DetectedAddress[],
  run: { text: string; start: number; end: number },
  item: TextItemLike,
  x: number,
): DetectedAddress {
  const [x0, , x1] = itemBox(item);
  const across = x1 > x0 ? Math.min(1, Math.max(0, (x - x0) / (x1 - x0))) : 0;
  // Characters are not evenly spaced, so this only ever chooses between
  // candidates that are already addresses; being a character or two out cannot
  // change which one is closest.
  const offset = run.start + Math.round(across * item.str.length);
  return addressAt(run.text, offset) ?? found[0];
}

/**
 * The item joined with the neighbours it visually touches, and where the item
 * itself sits in the result. An item with no touching neighbour is its own run.
 */
function joinRun(
  items: readonly TextItemLike[],
  index: number,
): { text: string; start: number; end: number } {
  const item = items[index];
  let text = item.str;
  let start = 0;

  for (let i = index - 1; i >= 0 && adjacent(items[i], items[i + 1]); i -= 1) {
    text = items[i].str + text;
    start += items[i].str.length;
  }

  const end = start + item.str.length;

  for (let i = index + 1; i < items.length && adjacent(items[i - 1], items[i]); i += 1) {
    text += items[i].str;
  }

  return { text, start, end };
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
