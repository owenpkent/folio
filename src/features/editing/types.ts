/**
 * Content the user adds on top of a page: text boxes, placed images, and
 * stamped check/cross marks (for ticking a printed checkbox that has no real
 * form field behind it -- a real AcroForm checkbox widget is instead handled
 * entirely by PDF.js's own annotation layer). Stored per document (keyed by
 * PDF fingerprint) in a local sidecar, exactly like annotations and
 * signatures, and baked into the PDF only when a copy is saved (see
 * features/export). These are additive overlays and never touch glyphs
 * already in the PDF; in-place editing of existing text is features/textedit.
 */

/** A rectangle as fractions (0..1) of the page, top-left origin. Survives zoom. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The font families we expose for text boxes. Each maps to a pdf-lib
 * `StandardFont` at bake time (plus a bold variant); WinAnsi/Latin only, which
 * is why non-Latin OCR text is out of scope for now.
 */
export type FontFamily = 'Helvetica' | 'Times' | 'Courier';

/** On-screen CSS font stack per family, chosen to roughly match the baked font. */
export const FONT_CSS: Record<FontFamily, string> = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

export const FONT_LABELS: Record<FontFamily, string> = {
  Helvetica: 'Sans',
  Times: 'Serif',
  Courier: 'Mono',
};

export const DEFAULT_FONT_SIZE_PT = 14;
export const DEFAULT_TEXT_COLOR = '#111111';

interface EditBase {
  id: string;
  /** 1-based page the item is placed on. */
  pageNumber: number;
  rect: NormalizedRect;
  createdAt: number;
}

export interface TextEdit extends EditBase {
  kind: 'text';
  text: string;
  fontFamily: FontFamily;
  bold: boolean;
  /** Font size in PDF points (screen px = fontSizePt * scale). */
  fontSizePt: number;
  /** `#rrggbb`. */
  colorHex: string;
}

export interface ImageEdit extends EditBase {
  kind: 'image';
  /** PNG/JPEG image as a data URL (also the <img> source on screen). */
  dataUrl: string;
  mime: 'image/png' | 'image/jpeg';
}

/**
 * The stamp glyphs for ticking a printed checkbox that has no real form field
 * behind it (see features/editing's module doc). Modeled on Adobe Acrobat's
 * Fill & Sign: a check for "yes", a cross for "no".
 */
export type MarkGlyph = 'check' | 'cross';

/**
 * Stroke paths for each glyph, defined in a 0-100 unit square (top-left
 * origin, y grows downward: ordinary SVG/screen convention). Shared by the
 * on-screen preview (EditLayer) and the baked PDF stroke (bake.ts) so the two
 * render identically; see bake.ts for how this box maps into PDF space.
 */
export const MARK_GLYPH_PATHS: Record<MarkGlyph, string> = {
  check: 'M 20 55 L 42 76 L 82 24',
  cross: 'M 22 22 L 78 78 M 78 22 L 22 78',
};

/** Stroke width for mark glyphs, in the same 0-100 unit square as the paths above. */
export const MARK_GLYPH_STROKE_WIDTH = 12;

export const DEFAULT_MARK_COLOR = '#111111';

/** Default mark size in PDF points, kept square: roughly a printed checkbox. */
export const DEFAULT_MARK_SIZE_PT = 13;

export interface MarkEdit extends EditBase {
  kind: 'mark';
  glyph: MarkGlyph;
  /** `#rrggbb`. */
  colorHex: string;
}

export type EditItem = TextEdit | ImageEdit | MarkEdit;

/** Style fields of a text box the inspector can change. */
export type TextStylePatch = Partial<
  Pick<TextEdit, 'text' | 'fontFamily' | 'bold' | 'fontSizePt' | 'colorHex'>
>;

/** Style fields of a mark the inspector can change. */
export type MarkStylePatch = Partial<Pick<MarkEdit, 'glyph'>>;
