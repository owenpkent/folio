import { rgb, StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';

import type { EditItem, FontFamily } from './types';

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
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
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
 * Bake placed text boxes and images into an already-loaded pdf-lib document.
 * Normalized rects are top-left origin; PDF space is bottom-left, hence the flip.
 */
export async function stampEdits(pdf: PDFDocument, edits: EditItem[]): Promise<void> {
  const pages = pdf.getPages();
  const fontCache = new Map<StandardFonts, PDFFont>();

  for (const item of edits) {
    const page = pages[item.pageNumber - 1];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const w = item.rect.width * pw;
    const h = item.rect.height * ph;
    const x = item.rect.x * pw;
    const yTop = ph - item.rect.y * ph; // top edge of the box in PDF coords

    if (item.kind === 'image') {
      const img =
        item.mime === 'image/png' ? await pdf.embedPng(item.dataUrl) : await pdf.embedJpg(item.dataUrl);
      page.drawImage(img, { x, y: yTop - h, width: w, height: h });
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
    const bottom = yTop - h;

    let baseline = yTop - size; // approx: first baseline sits ~one em below the top
    for (const line of wrapText(text, font, size, w)) {
      if (baseline < bottom) break; // clip to the box height
      if (line) page.drawText(line, { x, y: baseline, size, font, color: rgb(r, g, b) });
      baseline -= lineHeight;
    }
  }
}
