import { PDFHexString, PDFName, PDFNumber, type PDFDocument, type PDFPage } from 'pdf-lib';

import type { Annotation, NormalizedRect } from './types';

/**
 * Encode a PDF text string for the /Contents entry. `PDFHexString.fromText`
 * writes UTF-16BE with a byte-order mark, which is the only PDF text-string
 * form that survives characters above Latin-1 (CJK, accented letters, curly
 * quotes, emoji). `PDFString.of` would truncate each of those to a single
 * byte, so the screen-reader text this whole feature exists to carry would
 * arrive corrupted. See ISO 32000-1 7.9.2.2.
 */
function pdfText(value: string): PDFHexString {
  return PDFHexString.fromText(value);
}

/**
 * Write highlights and sticky notes into an already-loaded pdf-lib document as
 * real PDF annotations (/Highlight and /Text), not as flattened graphics.
 *
 * This is deliberate. Drawing them into the content stream would look identical
 * and be simpler, but it would produce marks a screen reader cannot see, a
 * reviewer cannot reply to, and no other reader can edit or remove. As real
 * annotations they carry their text in /Contents, which is both what assistive
 * technology reads and what PDF/UA requires of a non-widget annotation
 * (ISO 14289-1 7.18, via Matterhorn 28-004). See docs/508-conformance.md.
 *
 * Note the sticky-note *pin* is what gets exported: Folio's own on-page pin
 * position and the reviewer's comment. Readers draw their own icon for a /Text
 * annotation, so the exported file will not look pixel-identical to Folio's
 * pin, which is the correct trade for an annotation other tools understand.
 */
export function stampAnnotations(pdf: PDFDocument, annotations: Annotation[]): void {
  if (annotations.length === 0) return;
  const pages = pdf.getPages();
  const touched = new Set<PDFPage>();

  for (const annotation of annotations) {
    const page = pages[annotation.pageNumber - 1];
    if (!page) continue;

    const ref =
      annotation.type === 'highlight'
        ? buildHighlight(pdf, page, annotation)
        : buildNote(pdf, page, annotation);
    if (!ref) continue;

    page.node.addAnnot(ref);
    touched.add(page);
  }

  // "Every page on which there is an annotation shall contain in its page
  // dictionary the key Tabs, and its value shall be S" (ISO 14289-1 7.18.3).
  // It fixes tab order to the structure order and is the check annotation-adding
  // software most often misses.
  for (const page of touched) {
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'));
  }
}

function buildHighlight(pdf: PDFDocument, page: PDFPage, annotation: Annotation) {
  if (annotation.rects.length === 0) return null;
  const { width: pw, height: ph } = page.getSize();

  // Convert each line's rect once, then derive both the quad points and the
  // enclosing Rect from the same boxes.
  const boxes = annotation.rects.map((rect) => toPdfRect(rect, pw, ph));

  // One quad per highlighted line. Per PDF 32000-1 12.5.6.10 the eight numbers
  // are the corners in the order upper-left, upper-right, lower-left,
  // lower-right — not a simple rectangle winding.
  const quads: number[] = [];
  for (const { x1, y1, x2, y2 } of boxes) {
    quads.push(x1, y2, x2, y2, x1, y1, x2, y1);
  }

  const box = boundingBox(boxes);
  const dict = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [box.x1, box.y1, box.x2, box.y2],
    QuadPoints: quads.map((n) => PDFNumber.of(n)),
    C: rgbTriplet(annotation.color),
    // The highlighted text itself: what a screen reader announces for this
    // annotation, and what PDF/UA expects a non-widget annotation to carry.
    Contents: pdfText(annotation.text ?? ''),
    // Print (bit 3). Without it a highlight is screen-only in most readers.
    F: 4,
  });
  return pdf.context.register(dict);
}

function buildNote(pdf: PDFDocument, page: PDFPage, annotation: Annotation) {
  const anchor = annotation.anchor;
  if (!anchor) return null;
  const { width: pw, height: ph } = page.getSize();

  // A /Text annotation's rect is the icon's box; readers size the icon
  // themselves. 20pt is the conventional square Acrobat uses.
  const size = 20;
  const x = anchor.x * pw;
  const y = ph - anchor.y * ph - size;

  const dict = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Name: 'Comment',
    Rect: [x, y, x + size, y + size],
    // The reviewer's comment is the annotation's content. Fall back to the
    // captured page text so a note left empty still says what it marks.
    Contents: pdfText(annotation.note?.trim() || annotation.text || ''),
    C: rgbTriplet(annotation.color),
    F: 4,
    // Closed, so the note shows as an icon rather than a popped-open box.
    Open: false,
  });
  return pdf.context.register(dict);
}

/** Normalized (top-left origin) rect → PDF user space (bottom-left origin). */
function toPdfRect(rect: NormalizedRect, pw: number, ph: number) {
  const x1 = rect.x * pw;
  const x2 = (rect.x + rect.width) * pw;
  const y2 = ph - rect.y * ph;
  const y1 = ph - (rect.y + rect.height) * ph;
  return { x1, y1, x2, y2 };
}

type PdfRect = ReturnType<typeof toPdfRect>;

function boundingBox(boxes: PdfRect[]) {
  return {
    x1: Math.min(...boxes.map((b) => b.x1)),
    y1: Math.min(...boxes.map((b) => b.y1)),
    x2: Math.max(...boxes.map((b) => b.x2)),
    y2: Math.max(...boxes.map((b) => b.y2)),
  };
}

/**
 * CSS color → the /C array, which is three 0..1 components and has no alpha.
 * Folio's highlight colors are translucent rgba(); readers apply their own
 * multiply blend, so the alpha is dropped rather than approximated.
 */
function rgbTriplet(color: string): number[] {
  const match = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (match) {
    return [Number(match[1]) / 255, Number(match[2]) / 255, Number(match[3]) / 255];
  }
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  // Unknown format: a neutral yellow beats writing an invalid /C array.
  return [1, 0.84, 0.04];
}
