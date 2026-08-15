/**
 * Hit-testing PDF.js text items against a point in PDF user space.
 *
 * Two features scan a page's text items for the one under a point: the
 * link/address feature (src/features/links/resolve.ts) to find an address to
 * copy, and in-place text editing (src/features/textedit/TextEditLayer.tsx) to
 * find the run a click should open for editing. Both want the exact same
 * geometry -- the same slack around each item's box, the same descender
 * allowance below the baseline, the same smallest-box-wins tie-break -- so it
 * lives here once rather than as two copies drifting apart.
 */

/** The parts of a PDF.js text item a hit test needs, named so tests can build one. */
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** PDF.js mixes marked-content markers into a page's item list; those carry no text. */
export function isTextItem(item: unknown): item is TextItemLike {
  const candidate = item as Partial<TextItemLike>;
  return typeof candidate?.str === 'string' && Array.isArray(candidate.transform);
}

/** Slack around a box, in PDF units, so a click or a right-click near an item still finds it. */
export const HIT_PAD = 2;

/**
 * The item's box in PDF user space, `[x0, y0, x1, y1]`. The allowance below the
 * baseline covers descenders without inflating the box enough for neighbouring
 * lines to overlap.
 */
export function itemBox(item: TextItemLike): [number, number, number, number] {
  const x = item.transform[4];
  const y = item.transform[5];
  return [x, y - 0.2 * item.height, x + item.width, y + item.height];
}

/** The index of the smallest item box containing the point, or -1 if none does. */
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
