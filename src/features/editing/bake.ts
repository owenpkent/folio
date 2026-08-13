import { LineCapStyle, rgb, StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';

import { offsetInFrame, placeRect } from '@/core/pdf/pageGeometry';

import { MARK_GLYPH_PATHS, MARK_GLYPH_STROKE_WIDTH, type EditItem, type FontFamily } from './types';

/** Map a family + bold to the matching pdf-lib StandardFont (WinAnsi/Latin). */
export function standardFontFor(family: FontFamily, bold: boolean): StandardFonts {
  switch (family) {
    case 'Times':
      return bold ? StandardFonts.TimesRomanBold : StandardFonts.TimesRoman;
    case 'Courier':
      return bold ? StandardFonts.CourierBold : StandardFonts.Courier;
    case 'Helvetica':
    default:
      return bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica;
  }
}

/** Parse `#rrggbb` (or `#rgb`) into 0..1 components; falls back to black. */
export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/**
 * Word-wrap `text` to `maxWidth` (PDF points) for the given font/size. Honors
 * existing newlines; a single word wider than the box is kept on its own line
 * (it will overflow, matching how the on-screen box clips). Best-effort: the
 * baked wrapping approximates the browser's CSS wrapping.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Bake placed text boxes, images, and check marks into an already-loaded
 * pdf-lib document. Normalized rects are top-left origin, of the page *as
 * displayed*; {@link placeRect} turns that into pdf-lib's bottom-left user
 * space and supplies the `rotate` that keeps the stamp upright on a page with
 * a non-zero `/Rotate` (see core/pdf/pageGeometry.ts).
 */
export async function stampEdits(pdf: PDFDocument, edits: EditItem[]): Promise<void> {
  const pages = pdf.getPages();
  const fontCache = new Map<StandardFonts, PDFFont>();

  for (const item of edits) {
    const page = pages[item.pageNumber - 1];
    if (!page) continue;
    const placement = placeRect(page, item.rect);
    const { x, y, width: w, height: h, rotate } = placement;

    if (item.kind === 'image') {
      const img =
        item.mime === 'image/png'
          ? await pdf.embedPng(item.dataUrl)
          : await pdf.embedJpg(item.dataUrl);
      page.drawImage(img, { x, y, width: w, height: h, rotate });
      continue;
    }

    if (item.kind === 'mark') {
      // drawSvgPath's path coordinates use an SVG-style y-axis (down is
      // positive) -- pdf-lib's own source calls this out ("SVG path Y axis is
      // opposite pdf-lib's") and compensates with an internal scale(1, -1).
      // Empirically confirmed (a probe script drawing this exact shape and
      // decoding the emitted content stream): for a local path point (px,
      // py), the point lands at PDF page coordinates (x + px, y - py). So,
      // unlike drawImage above (whose `y` is the *bottom* of the image), the
      // (x, y) anchor here behaves like the *top* of the path's local box:
      // passing the point `h` up from placement's bottom-left, with
      // MARK_GLYPH_PATHS' top-left-origin 0-100 box, renders right-side up
      // with no manual flip. offsetInFrame measures that "up" along the
      // placement's own axes, not the page's, so this still lands on the
      // box's top edge once the page is turned. Marks are always kept square
      // (EditLayer locks the aspect ratio on resize), so one scale factor for
      // both axes is safe.
      const { x: topX, y: topY } = offsetInFrame(placement, 0, h);
      const { r, g, b } = hexToRgb01(item.colorHex);
      page.drawSvgPath(MARK_GLYPH_PATHS[item.glyph], {
        x: topX,
        y: topY,
        scale: w / 100,
        rotate,
        borderColor: rgb(r, g, b),
        borderWidth: MARK_GLYPH_STROKE_WIDTH,
        borderLineCap: LineCapStyle.Round,
      });
      continue;
    }

    const text = item.text ?? '';
    if (!text.trim()) continue;

    const fontName = standardFontFor(item.fontFamily, item.bold);
    let font = fontCache.get(fontName);
    if (!font) {
      font = await pdf.embedFont(fontName);
      fontCache.set(fontName, font);
    }
    const size = item.fontSizePt;
    const { r, g, b } = hexToRgb01(item.colorHex);
    const lineHeight = size * 1.15;

    // Distance up from the box's bottom edge, along the placement's own
    // axes; offsetInFrame turns that into a real anchor for drawText below.
    // Starts one em below the top (an approximation of the first baseline)
    // and works down, same as the page-space math this replaces.
    let dy = h - size;
    for (const line of wrapText(text, font, size, w)) {
      if (dy < 0) break; // clip to the box height
      if (line) {
        const { x: bx, y: by } = offsetInFrame(placement, 0, dy);
        page.drawText(line, { x: bx, y: by, size, font, color: rgb(r, g, b), rotate });
      }
      dy -= lineHeight;
    }
  }
}
