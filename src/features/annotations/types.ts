export type AnnotationType = 'highlight' | 'note';

/** A rectangle expressed as fractions (0..1) of the page, so it survives zoom. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Annotation {
  id: string;
  type: AnnotationType;
  /** 1-based page. */
  pageNumber: number;
  /** CSS color (may be translucent). */
  color: string;
  /** One rect per line of a highlight; empty for a point note. */
  rects: NormalizedRect[];
  /**
   * Anchor point as page fractions (0..1), for a sticky note. This is where the
   * pin sits and what the AI export reports so a note can be located on the page.
   */
  anchor?: { x: number; y: number };
  /**
   * For a highlight: the highlighted text. For a note: the page text nearest the
   * anchor, captured at placement so an AI reading the doc back can tell what the
   * note refers to.
   */
  text?: string;
  /** The reviewer's comment (the body of a sticky note). */
  note?: string;
  createdAt: number;
}

export interface HighlightColor {
  name: string;
  value: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { name: 'Yellow', value: 'rgba(255, 214, 10, 0.45)' },
  { name: 'Green', value: 'rgba(52, 199, 89, 0.40)' },
  { name: 'Blue', value: 'rgba(0, 122, 255, 0.35)' },
  { name: 'Pink', value: 'rgba(255, 45, 85, 0.32)' },
];

export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].value;
