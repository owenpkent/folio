import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';

import { offsetInFrame, placeRect } from '@/core/pdf/pageGeometry';

import type { OcrPage } from './types';

/**
 * Bake recognized OCR words into an already-loaded pdf-lib document as an
 * invisible (opacity 0) text layer, positioned per word. This makes a scanned
 * PDF searchable and copyable in any reader while leaving the image untouched.
 *
 * Text is drawn with Helvetica (WinAnsi); words containing characters the font
 * cannot encode are skipped individually rather than failing the whole save.
 * Alignment is approximate (one draw per word box) -- fine for search/copy.
 */
export async function stampOcrLayer(pdf: PDFDocument, pages: OcrPage[]): Promise<void> {
  if (pages.length === 0) return;
  const font: PDFFont = await pdf.embedFont(StandardFonts.Helvetica);
  const pdfPages = pdf.getPages();

  for (const ocrPage of pages) {
    const page = pdfPages[ocrPage.pageNumber - 1];
    if (!page) continue;

    for (const word of ocrPage.words) {
      const text = word.text;
      if (!text.trim()) continue;
      // placeRect turns the normalized (top-left, as-displayed) word box into
      // pdf-lib's bottom-left user space and supplies the rotate that keeps
      // the invisible text aligned with the visible glyphs underneath on a
      // page with a non-zero /Rotate (see core/pdf/pageGeometry.ts).
      const placement = placeRect(page, word.rect);
      const size = Math.max(4, placement.height * 0.9);
      // Baseline sits just above the bottom of the word box, offset along
      // the placement's own axes so it still lands inside the box once the
      // page is turned.
      const { x, y } = offsetInFrame(placement, 0, placement.height * 0.15);
      try {
        page.drawText(text, { x, y, size, font, opacity: 0, rotate: placement.rotate });
      } catch {
        // Skip a word the standard font can't encode (e.g. non-Latin glyphs).
      }
    }
  }
}
