import type { PageViewport } from 'pdfjs-dist';

/** A rectangle as PDF.js passes them around: [x0, y0, x1, y1]. */
export type Rect4 = [number, number, number, number];

/**
 * A PDF-user-space rectangle in viewport (CSS pixel) coordinates.
 *
 * PDF.js 6 dropped `PageViewport.convertToViewportRectangle`; this is the two
 * corner conversions it did, spelled out. Note the result is not normalised:
 * the y axis flips, so y0 > y1 for an unrotated page, exactly as before.
 *
 * Lives behind the core/pdf barrel for the same reason the PageViewport type
 * does -- callers must not reach for pdfjs-dist themselves.
 */
export function convertToViewportRectangle(viewport: PageViewport, rect: Rect4): Rect4 {
  const [x0, y0] = viewport.convertToViewportPoint(rect[0], rect[1]) as [number, number];
  const [x1, y1] = viewport.convertToViewportPoint(rect[2], rect[3]) as [number, number];
  return [x0, y0, x1, y1];
}
