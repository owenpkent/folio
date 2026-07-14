import { StandardFonts, type PDFDocument, type PDFFont } from 'pdf-lib';

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
    const { width: pw, height: ph } = page.getSize();

    for (const word of ocrPage.words) {
      const text = word.text;
      if (!text.trim()) continue;
      const boxH = word.rect.height * ph;
      const size = Math.max(4, boxH * 0.9);
      const x = word.rect.x * pw;
      // Baseline sits just above the bottom of the word box (top-left → bottom-left).
      const y = ph - word.rect.y * ph - boxH + boxH * 0.15;
      try {
        page.drawText(text, { x, y, size, font, opacity: 0 });
      } catch {
        // Skip a word the standard font can't encode (e.g. non-Latin glyphs).
      }
    }
  }
}
