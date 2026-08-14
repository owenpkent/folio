import { convertToViewportRectangle, getEngine } from '@/core/pdf';
import { useOcrStore } from '@/features/ocr';

import {
  pickLink,
  targetFromLink,
  targetFromOcr,
  targetFromText,
  type CopyTarget,
  type TextItemLike,
} from './resolve';

/** A box as fractions (0..1) of the displayed page, top-left origin. */
export interface AddressRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AddressHit {
  target: CopyTarget;
  /** Where it sits on the page, for the hover hint. */
  region: AddressRegion;
}

/**
 * The address under a point on a page, if there is one.
 *
 * `cssX` / `cssY` are relative to the page element's top-left corner, at the
 * scale the page is currently rendered at, which is what the viewport needs to
 * convert them into PDF user space.
 *
 * Three sources, in priority order: the `/Link` annotations the author declared,
 * then addresses printed in the page's own text, then text Folio recognised on
 * a scan. The author's link wins because it is what a click would follow, even
 * where the words printed over it say otherwise.
 *
 * Never throws: a right-click has to open its menu, and a hover must not break
 * the page, whatever the engine is doing.
 */
export async function copyTargetAt(
  pageNumber: number,
  cssX: number,
  cssY: number,
  scale: number,
): Promise<AddressHit | null> {
  const engine = getEngine();
  try {
    // Independent reads, resolved together rather than one after another: on
    // a page whose caches are still cold (the first hover or right-click on
    // it), this is the difference between one worker round trip and three
    // taken in series.
    const [viewport, links, textItems] = await Promise.all([
      engine.getPageViewport(pageNumber, scale),
      engine.getPageLinks(pageNumber),
      engine.getTextItems(pageNumber),
    ]);
    const [x, y] = viewport.convertToPdfPoint(cssX, cssY) as [number, number];
    const toRegion = (rect: [number, number, number, number]) => normalize(viewport, rect);

    const link = pickLink(links, x, y);
    if (link) return { target: targetFromLink(link), region: toRegion(link.rect) };

    // Widened to unknown[] first: PDF.js types the list as a union with
    // marked-content markers, which the guard below is what separates out.
    const items = textItems.items as unknown[];
    const inText = targetFromText(items.filter(isTextItem), x, y);
    if (inText) return { target: inText.target, region: toRegion(inText.rect) };

    // Already in fractions of the displayed page, so no conversion.
    const words = useOcrStore.getState().pages[pageNumber]?.words ?? [];
    const inScan = targetFromOcr(words, cssX / viewport.width, cssY / viewport.height);
    return inScan ? { target: inScan.target, region: inScan.rect } : null;
  } catch {
    return null;
  }
}

/**
 * A PDF-user-space rect as fractions of the displayed page.
 *
 * Goes through the viewport rather than dividing by the page's own size,
 * because the viewport is what has already applied the page's `/Rotate`.
 */
function normalize(
  viewport: { width: number; height: number },
  rect: [number, number, number, number],
): AddressRegion {
  const [vx0, vy0, vx1, vy1] = convertToViewportRectangle(
    viewport as Parameters<typeof convertToViewportRectangle>[0],
    rect,
  );
  const left = Math.min(vx0, vx1);
  const top = Math.min(vy0, vy1);
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    width: Math.abs(vx1 - vx0) / viewport.width,
    height: Math.abs(vy1 - vy0) / viewport.height,
  };
}

/** PDF.js mixes marked-content markers into the item list; those carry no text. */
function isTextItem(item: unknown): item is TextItemLike {
  const candidate = item as Partial<TextItemLike>;
  return typeof candidate?.str === 'string' && Array.isArray(candidate.transform);
}
