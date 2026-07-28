/**
 * Selecting, moving, resizing, and replacing images already embedded in a PDF
 * page (feature: imageedit).
 *
 * Unlike features/editing (additive, overlay-only placed images), this
 * feature edits an image XObject's existing placement in the page content
 * stream, or swaps which XObject a `/Name Do` draws, rather than adding
 * something new on top. Pipeline:
 *   1. contentStream.ts's `onImageOp` sink reports every `Do` the parser did
 *      not descend into (see LocatedImageOp there): a resource name, a byte
 *      range, and the CTM in effect, which for an image is its entire
 *      placement (images paint the unit square; there is no text matrix
 *      involved the way there is for a text run).
 *   2. mutate.ts resolves each name against the page's (or a form's) object
 *      model, keeping only `/Subtype /Image`, and turns the CTM into an
 *      axis-aligned page-space rect.
 *   3. The UI matches a click to the topmost located image under the pointer.
 *   4. mutate.ts rewrites the operator in place: `q <A> cm /Name Do Q` for a
 *      move or resize, a swapped resource name for a replace, or removes the
 *      operator outright for a delete.
 */

/** A rectangle in PDF user space (bottom-left origin), width/height always positive. */
export interface ImageEditRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An image embedded via `pdf.embedPng` / `pdf.embedJpg`, matching features/editing's ImageEdit. */
export type ImageMime = 'image/png' | 'image/jpeg';

/**
 * An image XObject painted by a `/Name Do` operator, located in a page's
 * content stream(s) and resolved against the object model (see this file's
 * header). Modeled on features/textedit's LocatedRun: geometry plus whether
 * (and why not) it can be edited.
 */
export interface LocatedImage {
  /** Index into the page's Contents array, or a resolved form's assigned id (>= the page's own stream count). */
  streamIndex: number;
  /** Byte offset of the operator's first operand (the name token) in the decoded stream. */
  start: number;
  /** Byte offset just past the operator token in the decoded stream. */
  end: number;
  /** XObject resource name, e.g. "Im1". */
  name: string;
  /** CTM in effect at the Do, as [a, b, c, d, e, f]; see contentStream.ts's LocatedImageOp. */
  ctm: [number, number, number, number, number, number];
  /**
   * The image's axis-aligned placement in PDF user space, normalized so
   * width/height are always positive. A negative `a` or `d` in the CTM mirrors
   * the image (see flipX/flipY); the rect is normalized around that, not the
   * raw (possibly negative) extents.
   */
  rect: ImageEditRect;
  /** True when the CTM's `a` was negative: the image is mirrored horizontally. */
  flipX: boolean;
  /** True when the CTM's `d` was negative: the image is mirrored vertically. */
  flipY: boolean;
  /** The image XObject's own pixel dimensions (`/Width`, `/Height`), for aspect-locked resizing. */
  naturalWidth: number;
  naturalHeight: number;
  /**
   * False when the CTM is rotated or skewed (`b` or `c` non-zero) or
   * degenerate (`a` or `d` within ~1e-6 of 0): moving or resizing would need
   * to recompute the matrix, which this feature refuses rather than risk a
   * wrong result (see mutate.ts). Replacing or deleting the image is
   * unaffected by this flag: neither one touches the matrix.
   */
  transformable: boolean;
  /**
   * False when this image was found inside a Form XObject. The clone-and-
   * redirect discipline commitTextEdit uses to safely edit text inside a
   * form (see features/textedit/mutate.ts) is not implemented here, so every
   * action -- move, resize, replace, and delete -- is refused for now.
   */
  editable: boolean;
  /** Reason `editable` (or, for an otherwise-editable image, `transformable`) is false. */
  blockedReason?: string;
}

/**
 * Enough to re-locate a specific image at commit time: the streamIndex and
 * name it was found under, plus its rect when it was targeted (a tiebreaker
 * when the same resource is drawn more than once on the page; see
 * matchImageToTarget). Mirrors features/textedit's EditingSessionTarget.
 */
export interface ImageEditTarget {
  streamIndex: number;
  name: string;
  rect: ImageEditRect;
}

/**
 * The image currently showing selection chrome: an ImageEditTarget plus the
 * page it lives on, since a target alone does not say which page to re-locate
 * it on (mirrors how features/textedit's EditingSession pairs its own target
 * with a pageIndex). Held by useImageEditStore; ImageEditLayer renders chrome
 * only on the one page whose index matches.
 */
export interface SelectedImage extends ImageEditTarget {
  pageIndex: number;
}

/** What to do to the image `target` resolves to (see CommitImageEditParams). */
export type ImageEditAction =
  | { kind: 'move'; rect: ImageEditRect }
  | { kind: 'replace'; dataUrl: string; mime: ImageMime }
  | { kind: 'delete' };

export interface CommitImageEditParams {
  /** Current canonical document bytes (must already include form values). */
  pdfBytes: Uint8Array;
  /** 0-based page index. */
  pageIndex: number;
  target: ImageEditTarget;
  action: ImageEditAction;
}

export type ImageEditErrorCode = 'page-out-of-range' | 'image-not-found' | 'image-not-editable';
