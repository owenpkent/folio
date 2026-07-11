export type SignatureSource = 'draw' | 'type' | 'upload';

/** A rectangle as fractions (0..1) of the page, top-left origin. Survives zoom. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Signature {
  id: string;
  /** 1-based page the signature is placed on. */
  pageNumber: number;
  /** PNG image of the signature, as a data URL. */
  dataUrl: string;
  rect: NormalizedRect;
  createdAt: number;
}

export interface CreatedSignature {
  dataUrl: string;
  /** width / height of the image, used to preserve aspect ratio on placement. */
  aspect: number;
}

export const SIGNATURE_FONTS: { name: string; value: string }[] = [
  { name: 'Script', value: '"Segoe Script", "Brush Script MT", "Snell Roundhand", cursive' },
  { name: 'Serif', value: 'Georgia, "Times New Roman", serif' },
  { name: 'Sans', value: 'system-ui, "Helvetica Neue", Arial, sans-serif' },
];
