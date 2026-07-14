/**
 * Content the user adds on top of a page: text boxes and placed images. Stored
 * per document (keyed by PDF fingerprint) in a local sidecar, exactly like
 * annotations and signatures, and baked into the PDF only when a copy is saved
 * (see features/export). We deliberately do NOT edit glyphs already in the PDF;
 * these are additive overlays.
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

export type EditItem = TextEdit | ImageEdit;

/** Style fields of a text box the inspector can change. */
export type TextStylePatch = Partial<Pick<TextEdit, 'text' | 'fontFamily' | 'bold' | 'fontSizePt' | 'colorHex'>>;
