import { getEngine } from '@/core/pdf';

import {
  pickLink,
  targetFromLink,
  targetFromText,
  type CopyTarget,
  type TextItemLike,
} from './resolve';

/**
 * The address under a point on a page, if there is one.
 *
 * `cssX` / `cssY` are relative to the page element's top-left corner, at the
 * scale the page is currently rendered at, which is what the viewport needs to
 * convert them into PDF user space.
 *
 * Never throws: a right-click has to open its menu whatever the engine is
 * doing, so a document mid-reload just means no address was found.
 */
export async function copyTargetAt(
  pageNumber: number,
  cssX: number,
  cssY: number,
  scale: number,
): Promise<CopyTarget | null> {
  const engine = getEngine();
  try {
    const viewport = await engine.getPageViewport(pageNumber, scale);
    const [x, y] = viewport.convertToPdfPoint(cssX, cssY) as [number, number];

    // The author's own link beats anything spotted in the text: it is what a
    // click would follow, even where the words printed over it say otherwise.
    const link = pickLink(await engine.getPageLinks(pageNumber), x, y);
    if (link) return targetFromLink(link);

    // Widened to unknown[] first: PDF.js types the list as a union with
    // marked-content markers, which the guard below is what separates out.
    const items = (await engine.getTextItems(pageNumber)).items as unknown[];
    return targetFromText(items.filter(isTextItem), x, y);
  } catch {
    return null;
  }
}

/** PDF.js mixes marked-content markers into the item list; those carry no text. */
function isTextItem(item: unknown): item is TextItemLike {
  const candidate = item as Partial<TextItemLike>;
  return typeof candidate?.str === 'string' && Array.isArray(candidate.transform);
}
