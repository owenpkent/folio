/**
 * pdf-lib side of image editing: locate an image XObject already drawn on a
 * page, and move, resize, replace, or delete it by rewriting the `/Name Do`
 * operator that draws it. See ./types.ts for the overall pipeline and
 * features/textedit/contentStream.ts for the tokenizer/interpreter this
 * builds on (its `onImageOp` sink is where every candidate `Do` comes from).
 *
 * Images located inside a Do-invoked Form XObject are never edited: doing so
 * safely needs the same clone-and-redirect discipline commitTextEdit uses for
 * text inside a form (see features/textedit/mutate.ts), which is not
 * implemented here yet. Such an image is still reported (so the UI can select
 * it and explain why, the same way a rotated text run does) but every action
 * -- move, resize, replace, delete -- is refused; see LocatedImage.editable.
 */

import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFPage,
} from 'pdf-lib';

import {
  parseContentStreams,
  removeOperatorBytes,
  spliceOperatorBytes,
  type FormResolver,
  type LocatedImageOp,
} from '@/features/textedit/contentStream';
import {
  decodePageContentStreams,
  mergeStreams,
  resourcesForStream,
  type FormEntry,
} from '@/features/textedit/mutate';

import type {
  CommitImageEditParams,
  ImageEditErrorCode,
  ImageEditRect,
  ImageEditTarget,
  LocatedImage,
} from './types';

export class ImageEditError extends Error {
  readonly code: ImageEditErrorCode;

  constructor(code: ImageEditErrorCode, message: string) {
    super(message);
    this.name = 'ImageEditError';
    this.code = code;
  }
}

function resolvePage(doc: PDFDocument, pageIndex: number): PDFPage {
  const pages = doc.getPages();
  const page = pages[pageIndex];
  if (pageIndex < 0 || !page) {
    throw new ImageEditError(
      'page-out-of-range',
      `Page ${pageIndex} is out of range (document has ${pages.length} pages)`,
    );
  }
  return page;
}

/** CTM components within this much of 0 count as 0 (an axis-aligned, non-degenerate placement). */
const AXIS_ALIGNED_EPSILON = 1e-6;

/**
 * Turn one located `Do` into a LocatedImage, given the image XObject's own
 * stream dict. The rect is the CTM's unit square, normalized to positive
 * width/height (see LocatedImage.flipX/flipY): for CTM [a b c d e f] with
 * b = c = 0, the unit square's corners land at x in [e, e+a] and y in
 * [f, f+d], so a negative `a` (or `d`) means the low end of that range is
 * `e+a` (or `f+d`) instead of `e` (or `f`), and the image is mirrored on that
 * axis.
 */
function toLocatedImage(op: LocatedImageOp, dict: PDFDict, streamCount: number): LocatedImage {
  const [a, b, c, d, e, f] = op.ctm;
  const naturalWidth = dict.lookupMaybe(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
  const naturalHeight = dict.lookupMaybe(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0;

  const rotatedOrSkewed = Math.abs(b) > AXIS_ALIGNED_EPSILON || Math.abs(c) > AXIS_ALIGNED_EPSILON;
  const degenerate = Math.abs(a) < AXIS_ALIGNED_EPSILON || Math.abs(d) < AXIS_ALIGNED_EPSILON;
  const insideForm = op.streamIndex >= streamCount;

  const flipX = a < 0;
  const flipY = d < 0;
  const rect: ImageEditRect = {
    x: flipX ? e + a : e,
    y: flipY ? f + d : f,
    width: Math.abs(a),
    height: Math.abs(d),
  };

  const image: LocatedImage = {
    streamIndex: op.streamIndex,
    start: op.start,
    end: op.end,
    name: op.name,
    ctm: op.ctm,
    rect,
    flipX,
    flipY,
    naturalWidth,
    naturalHeight,
    // Rotated/skewed and degenerate placements only block a matrix rewrite
    // (move/resize); replacing or deleting the operator never touches the
    // matrix, so both remain available (see editable below).
    transformable: !rotatedOrSkewed && !degenerate,
    editable: !insideForm,
  };
  if (insideForm) {
    image.blockedReason = 'Images inside a form or template are not editable yet';
  } else if (rotatedOrSkewed) {
    image.blockedReason = 'Rotated or skewed images cannot be moved or resized yet';
  } else if (degenerate) {
    image.blockedReason = 'This image has no visible size';
  }
  return image;
}

/**
 * Every image `Do` in a page's content stream(s), including ones found
 * inside a Do-invoked Form XObject (see toLocatedImage's insideForm case).
 * Shared by locatePageImages (a fresh decode from bytes) and commitImageEdit
 * (which already has the page loaded and needs the identical list to
 * re-locate its target).
 */
function locateImages(
  doc: PDFDocument,
  page: PDFPage,
  streams: Uint8Array[],
  resolveForm: FormResolver,
  forms: Map<number, FormEntry>,
): LocatedImage[] {
  const ops: LocatedImageOp[] = [];
  parseContentStreams(streams, resolveForm, (op) => ops.push(op));

  const pageResources = page.node.Resources();
  const images: LocatedImage[] = [];
  for (const op of ops) {
    const resources = resourcesForStream(op.streamIndex, streams.length, pageResources, forms);
    const xobjectDict = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const ref = xobjectDict?.get(PDFName.of(op.name));
    // Not resolvable at all (a stale or malformed name): nothing to report.
    if (!xobjectDict || !(ref instanceof PDFRef)) continue;

    const stream = doc.context.lookupMaybe(ref, PDFStream);
    if (!stream) continue;
    // A Form XObject reaching here would mean resolveForm failed to descend
    // into it (depth cap or a cycle; see contentStream.ts), so it is left
    // alone the same way parseContentStreams already leaves it alone.
    // Anything else that is not `/Subtype /Image` is equally uninteresting.
    const subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
    if (subtype !== PDFName.of('Image')) continue;

    images.push(toLocatedImage(op, stream.dict, streams.length));
  }
  return images;
}

export async function locatePageImages(
  pdfBytes: Uint8Array,
  pageIndex: number,
): Promise<LocatedImage[]> {
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);
  const { streams, resolveForm, forms } = decodePageContentStreams(doc, page);
  return locateImages(doc, page, streams, resolveForm, forms);
}

/**
 * PDF user-space units of slack when matching a target back to a located
 * image. Generous enough to absorb float round-trip through a fresh decode,
 * small enough to disambiguate the same resource name drawn at two different
 * rects (page-level Do's are independent byte ranges, so both are safe to
 * edit; this is only about picking the right one).
 */
const MATCH_TOLERANCE = 2;

/** The nearest located image matching `target`'s streamIndex, name, and (as a tiebreaker) rect origin. */
export function matchImageToTarget(
  images: LocatedImage[],
  target: ImageEditTarget,
): LocatedImage | undefined {
  let best: LocatedImage | undefined;
  let bestDistance = Infinity;
  for (const image of images) {
    if (image.streamIndex !== target.streamIndex || image.name !== target.name) continue;
    const distance = Math.hypot(image.rect.x - target.rect.x, image.rect.y - target.rect.y);
    if (distance <= MATCH_TOLERANCE && distance < bestDistance) {
      best = image;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The first editable image in `images`, in the order they were located (paint
 * order; see locateImages). Used by ImageEditLayer's click-catcher when it is
 * activated from the keyboard (Enter/Space): that click event carries no real
 * pointer position to hit-test, so it selects this instead of an arbitrary
 * point, the same "do something deterministic" fallback MarkPlaceCatcher
 * (features/editing/EditLayer.tsx) uses for the check-mark tool.
 */
export function firstEditableImage(images: LocatedImage[]): LocatedImage | undefined {
  return images.find((image) => image.editable);
}

/**
 * Format a computed number for embedding in a content stream operator (the
 * `A` matrix a move/resize prepends). Plain decimal only (`toFixed`): PDF
 * numbers do not allow the exponential notation `String(n)` can produce for
 * very small magnitudes (e.g. `1e-7`). Trailing zeros (and a bare trailing
 * '.') are trimmed for readability; `-0` normalizes to `0`.
 */
function formatPdfNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** Signed a/d/e/f for a normalized rect, the inverse of toLocatedImage's rect normalization. */
function signedPlacement(rect: ImageEditRect, flipX: boolean, flipY: boolean) {
  return {
    a: flipX ? -rect.width : rect.width,
    d: flipY ? -rect.height : rect.height,
    e: flipX ? rect.x + rect.width : rect.x,
    f: flipY ? rect.y + rect.height : rect.y,
  };
}

/**
 * The `A` matrix that, prepended as `q <A> cm` right before the existing
 * `/Name Do`, moves an axis-aligned image from its current placement to
 * `rect`. The Do's CTM is already M_old = [a 0 0 d e f] (image.ctm); `cm`
 * composes its operand *before* the existing CTM (contentStream.ts's `cm`
 * case does `state.ctm = concatMatrix([operand], state.ctm)`, i.e. a point is
 * transformed by the operand and then by whatever the CTM already was), so
 * the new CTM at the Do becomes concatMatrix(A, M_old). For that to equal the
 * target M_new = [a' 0 0 d' e' f'], concatMatrix's definition
 * ([a1*a2+b1*c2, ..., e1*a2+f1*c2+e2, e1*b2+f1*d2+f2]) with b/c = 0 on both
 * sides reduces to:
 *   A = [a'/a, 0, 0, d'/d, (e'-e)/a, (f'-f)/d]
 *
 * Empirically confirmed against real pdf-lib fixtures (mutate.test.ts):
 * decoding the rewritten stream and re-locating the image lands it exactly
 * at the target rect ("moves an image: the emitted matrix puts it at the
 * requested rect"), and a distinctive operator written just after the
 * original Do still decodes immediately after the rewritten one, at the same
 * relative position, not appended to the end of the stream ("preserves
 * z-order: the rewritten operator sits at the original byte position, not
 * appended").
 *
 * Callers must only reach this for a `transformable` image (axis-aligned,
 * `a`/`d` both away from 0): commitImageEdit checks that before calling in,
 * so the divisions below never see a near-zero denominator.
 */
function moveMatrix(
  image: LocatedImage,
  rect: ImageEditRect,
): [number, number, number, number, number, number] {
  const [a1, , , d1, e1, f1] = image.ctm;
  const { a: a2, d: d2, e: e2, f: f2 } = signedPlacement(rect, image.flipX, image.flipY);
  return [a2 / a1, 0, 0, d2 / d1, (e2 - e1) / a1, (f2 - f1) / d1];
}

/** PDF user-space slack below which two rects count as the same placement. */
const RECT_EPSILON = 1e-3;

function sameRect(a: ImageEditRect, b: ImageEditRect): boolean {
  return (
    Math.abs(a.x - b.x) < RECT_EPSILON &&
    Math.abs(a.y - b.y) < RECT_EPSILON &&
    Math.abs(a.width - b.width) < RECT_EPSILON &&
    Math.abs(a.height - b.height) < RECT_EPSILON
  );
}

/**
 * The largest rect of the given aspect ratio (width / height) that fits inside
 * `rect`, centered on it.
 *
 * A replace reuses the placement the original image was drawn at, and that
 * placement was sized for the original's own proportions. Handing a 1:1 logo
 * the box a 4:3 photo occupied would stretch it, which is never what the user
 * meant by "replace this image" -- so the box is kept and the new image is
 * fitted into it (letterboxed, not cropped), which preserves both the user's
 * chosen position and the new image's shape. Centering rather than anchoring a
 * corner keeps the visual weight where the old image was.
 */
function containRect(rect: ImageEditRect, aspect: number): ImageEditRect {
  if (!Number.isFinite(aspect) || aspect <= 0 || !rect.width || !rect.height) return rect;
  let { width, height } = rect;
  if (aspect > width / height) height = width / aspect;
  else width = height * aspect;
  return {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  };
}

/** The `q <matrix> cm /<name> Do Q` text that draws `name` at `rect`. */
function placementOperator(image: LocatedImage, rect: ImageEditRect, name: string): string {
  const [a, , , d, e, f] = moveMatrix(image, rect);
  return (
    `q ${formatPdfNumber(a)} 0 0 ${formatPdfNumber(d)} ` +
    `${formatPdfNumber(e)} ${formatPdfNumber(f)} cm /${name} Do Q`
  );
}

/** A fresh `/XObject` resource name not already used in `xobjectDict`. */
function uniqueXObjectName(xobjectDict: PDFDict): string {
  for (let n = 1; ; n++) {
    const candidate = `FolioImg${n}`;
    if (!xobjectDict.get(PDFName.of(candidate))) return candidate;
  }
}

/**
 * Replace one decoded stream in `streams` with `newBytes`, merge them back
 * into a single page content stream, and save. Mirrors commitTextEdit's
 * page-level (not-inside-a-form) write-back in features/textedit/mutate.ts;
 * every edit this module makes lands here, since an editable image is never
 * inside a form (see LocatedImage.editable).
 */
function saveWithEditedStream(
  doc: PDFDocument,
  page: PDFPage,
  streams: Uint8Array[],
  editedIndex: number,
  newBytes: Uint8Array,
): Promise<Uint8Array> {
  const spliced = streams.map((bytes, i) => (i === editedIndex ? newBytes : bytes));
  const mergedRef = doc.context.register(
    PDFRawStream.of(doc.context.obj({}), mergeStreams(spliced)),
  );
  page.node.set(PDFName.of('Contents'), mergedRef);
  return doc.save();
}

export async function commitImageEdit(params: CommitImageEditParams): Promise<Uint8Array> {
  const { pdfBytes, pageIndex, target, action } = params;
  const doc = await PDFDocument.load(pdfBytes);
  const page = resolvePage(doc, pageIndex);

  const { streams, resolveForm, forms } = decodePageContentStreams(doc, page);
  const images = locateImages(doc, page, streams, resolveForm, forms);
  const image = matchImageToTarget(images, target);
  if (!image) {
    throw new ImageEditError('image-not-found', 'Could not find that image in the page content');
  }
  if (!image.editable) {
    throw new ImageEditError(
      'image-not-editable',
      image.blockedReason ?? 'This image cannot be edited',
    );
  }
  // editable rules out streamIndex >= streams.length (found inside a Form
  // XObject; see toLocatedImage), so this always indexes one of the page's
  // own decoded streams, never a form's.
  const stream = streams[image.streamIndex];

  if (action.kind === 'delete') {
    const spliced = removeOperatorBytes(stream, image.start, image.end);
    return saveWithEditedStream(doc, page, streams, image.streamIndex, spliced);
  }

  if (action.kind === 'move') {
    if (!image.transformable) {
      throw new ImageEditError(
        'image-not-editable',
        image.blockedReason ?? 'This image cannot be moved or resized',
      );
    }
    const operator = placementOperator(image, action.rect, image.name);
    const spliced = spliceOperatorBytes(
      stream,
      image.start,
      image.end,
      new TextEncoder().encode(operator),
    );
    return saveWithEditedStream(doc, page, streams, image.streamIndex, spliced);
  }

  // action.kind === 'replace': the new image is embedded fresh under a
  // brand-new resource name and the Do's operand is repointed at it. The
  // ORIGINAL image XObject, which this page (or any other) may still name
  // elsewhere, is never touched or repointed.
  //
  // The placement is reused rather than recomputed from scratch, but it is
  // corrected for the new image's own proportions when that is possible: see
  // containRect, and the transformable branch below for the rotated/skewed
  // case, where the matrix cannot be rewritten and the operand swap alone is
  // all that happens.
  const embedded =
    action.mime === 'image/png'
      ? await doc.embedPng(action.dataUrl)
      : await doc.embedJpg(action.dataUrl);

  const pageResources = page.node.Resources();
  const xobjectDict = pageResources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!pageResources || !xobjectDict) {
    // Cannot happen: resolving this image as editable already required a
    // page Resources/XObject dict naming it (see locateImages). Guarded
    // rather than asserted so a future refactor slip fails as an ordinary
    // thrown error here instead of a crash.
    throw new ImageEditError('image-not-found', 'Could not find that image in the page content');
  }
  const newName = uniqueXObjectName(xobjectDict);

  // Clone Resources and its XObject subdictionary before adding the new
  // entry, then repoint the page at the clones -- the same discipline
  // commitTextEdit uses in features/textedit/mutate.ts -- so a Resources
  // dict shared with another page is never mutated in place.
  const clonedXObject = xobjectDict.clone(doc.context);
  clonedXObject.set(PDFName.of(newName), embedded.ref);
  const clonedResources = pageResources.clone(doc.context);
  clonedResources.set(PDFName.of('XObject'), clonedXObject);
  page.node.set(PDFName.of('Resources'), clonedResources);

  // Fit the new image into the box the old one occupied, so a differently
  // shaped replacement is letterboxed rather than stretched. Only possible for
  // a transformable (axis-aligned, non-degenerate) placement: moveMatrix has
  // nothing sound to divide by otherwise, so a rotated or skewed image keeps
  // the matrix it already had and the operand swap is the whole edit.
  const fitted = image.transformable
    ? containRect(image.rect, embedded.width / (embedded.height || 1))
    : image.rect;
  const operator = sameRect(fitted, image.rect)
    ? `/${newName} Do`
    : placementOperator(image, fitted, newName);

  const spliced = spliceOperatorBytes(
    stream,
    image.start,
    image.end,
    new TextEncoder().encode(operator),
  );
  return saveWithEditedStream(doc, page, streams, image.streamIndex, spliced);
}
