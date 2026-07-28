// @vitest-environment node
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { getPageContentStreams } from '@/features/textedit/mutate';

import {
  commitImageEdit,
  firstEditableImage,
  ImageEditError,
  locatePageImages,
  matchImageToTarget,
} from './mutate';
import type { ImageEditRect, ImageEditTarget, LocatedImage } from './types';

/** Every byte mapped 1:1 to a char code, matching how pdf-lib's hex-string text operands decode. */
function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const hex = (s: string) =>
  [...s]
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

// A valid 1x1 transparent PNG, the same fixture features/editing/bake.test.ts uses.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const targetFor = (image: LocatedImage): ImageEditTarget => ({
  streamIndex: image.streamIndex,
  name: image.name,
  rect: image.rect,
});

/** A one-page PDF with a single image drawn via pdf-lib's own drawImage, optionally followed by a text marker. */
async function onePagePdfWithImage(
  rect: ImageEditRect,
  opts?: { markerText?: string },
): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const img = await doc.embedPng(PNG_1x1);
  page.drawImage(img, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  if (opts?.markerText) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(opts.markerText, { x: 10, y: 10, size: 12, font });
  }
  return { bytes: await doc.save() };
}

/**
 * A one-page PDF with a single image XObject registered as "Im1", drawn by a
 * hand-written operator string. Used for placements pdf-lib's own drawImage
 * cannot produce (a flip, a rotation): mirrors how features/textedit's
 * mutate.test.ts hand-builds a Form XObject's content for the same reason.
 */
async function onePagePdfWithRawImageOp(operator: string): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const img = await doc.embedPng(PNG_1x1);
  page.node.setXObject(PDFName.of('Im1'), img.ref);
  const contentRef = doc.context.register(
    PDFRawStream.of(doc.context.obj({}), new TextEncoder().encode(operator)),
  );
  page.node.set(PDFName.of('Contents'), contentRef);
  return { bytes: await doc.save() };
}

/**
 * A one-page PDF whose only image draw is inside a Do-invoked Form XObject
 * (registered as "Fm1"), which in turn draws the image (registered as "Im1"
 * in the form's own Resources). Mirrors features/textedit/mutate.test.ts's
 * pdfWithForm, but for an image instead of text.
 */
async function pdfWithImageInForm(): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(PNG_1x1);
  const encoder = new TextEncoder();

  const formBytes = encoder.encode('100 0 0 80 20 20 cm /Im1 Do');
  const formDict = doc.context.obj({
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: [0, 0, 300, 200],
    Resources: { XObject: { Im1: img.ref } },
  });
  const formRef = doc.context.register(PDFRawStream.of(formDict, formBytes));

  const page = doc.addPage([595, 842]);
  page.node.setXObject(PDFName.of('Fm1'), formRef);
  const contentRef = doc.context.register(
    PDFRawStream.of(doc.context.obj({}), encoder.encode('/Fm1 Do')),
  );
  page.node.set(PDFName.of('Contents'), contentRef);

  return { bytes: await doc.save() };
}

/** The PDFRef a page's Resources/XObject dict maps `name` to, or undefined. */
async function xobjectRef(
  bytes: Uint8Array,
  pageIndex: number,
  name: string,
): Promise<string | undefined> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(pageIndex);
  const xobject = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const ref = xobject?.get(PDFName.of(name));
  return ref instanceof PDFRef ? ref.toString() : undefined;
}

describe('locatePageImages', () => {
  it('rejects an out-of-range page index', async () => {
    const { bytes } = await onePagePdfWithImage({ x: 0, y: 0, width: 10, height: 10 });
    await expect(locatePageImages(bytes, 5)).rejects.toMatchObject({ code: 'page-out-of-range' });
  });

  it('locates an axis-aligned image with its page rect, natural size, and editable=true', async () => {
    const { bytes } = await onePagePdfWithImage({ x: 100, y: 150, width: 50, height: 80 });
    const images = await locatePageImages(bytes, 0);

    expect(images).toHaveLength(1);
    const [image] = images;
    expect(image.rect.x).toBeCloseTo(100);
    expect(image.rect.y).toBeCloseTo(150);
    expect(image.rect.width).toBeCloseTo(50);
    expect(image.rect.height).toBeCloseTo(80);
    expect(image.flipX).toBe(false);
    expect(image.flipY).toBe(false);
    // PNG_1x1 is a literal 1x1 pixel image.
    expect(image.naturalWidth).toBe(1);
    expect(image.naturalHeight).toBe(1);
    expect(image.transformable).toBe(true);
    expect(image.editable).toBe(true);
  });

  it('normalizes the rect and records the sign for a horizontally flipped image', async () => {
    // a = -100 mirrors the image; the unit square's low x edge is e+a, not e.
    const { bytes } = await onePagePdfWithRawImageOp('-100 0 0 80 300 100 cm /Im1 Do');
    const [image] = await locatePageImages(bytes, 0);

    expect(image.flipX).toBe(true);
    expect(image.flipY).toBe(false);
    expect(image.rect).toEqual({ x: 200, y: 100, width: 100, height: 80 });
    expect(image.transformable).toBe(true);
  });

  it('reports transformable=false (but editable=true) for a rotated or skewed image', async () => {
    // A ~30deg rotation: b and c are both clearly non-zero, a and d are not
    // (isolating the rotated/skewed case from the degenerate one below).
    const { bytes } = await onePagePdfWithRawImageOp('0.866 0.5 -0.5 0.866 100 100 cm /Im1 Do');
    const [image] = await locatePageImages(bytes, 0);

    expect(image.editable).toBe(true);
    expect(image.transformable).toBe(false);
    expect(image.blockedReason).toMatch(/rotated|skewed/i);
  });

  it('reports transformable=false for a degenerate (zero-width) placement', async () => {
    const { bytes } = await onePagePdfWithRawImageOp('0 0 0 80 300 100 cm /Im1 Do');
    const [image] = await locatePageImages(bytes, 0);

    expect(image.transformable).toBe(false);
    expect(image.blockedReason).toBe('This image has no visible size');
  });

  it('reports an image inside a Form XObject as not editable', async () => {
    const { bytes } = await pdfWithImageInForm();
    const images = await locatePageImages(bytes, 0);

    expect(images).toHaveLength(1);
    expect(images[0].editable).toBe(false);
    expect(images[0].blockedReason).toMatch(/form|template/i);
    // Assigned a form streamId, not one of the page's own (single) stream.
    expect(images[0].streamIndex).toBeGreaterThanOrEqual(1);
  });
});

describe('matchImageToTarget', () => {
  it('disambiguates two images with the same streamIndex and name by rect proximity', () => {
    const base = {
      streamIndex: 0,
      start: 0,
      end: 0,
      name: 'Im1',
      ctm: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
      flipX: false,
      flipY: false,
      naturalWidth: 1,
      naturalHeight: 1,
      transformable: true,
      editable: true,
    };
    const near: LocatedImage = { ...base, rect: { x: 1, y: 0, width: 10, height: 10 } };
    const far: LocatedImage = { ...base, rect: { x: 50, y: 0, width: 10, height: 10 } };

    const target: ImageEditTarget = {
      streamIndex: 0,
      name: 'Im1',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(matchImageToTarget([far, near], target)).toBe(near);
  });

  it('returns undefined when nothing matches within tolerance', () => {
    const target: ImageEditTarget = {
      streamIndex: 0,
      name: 'Im1',
      rect: { x: 0, y: 0, width: 10, height: 10 },
    };
    expect(matchImageToTarget([], target)).toBeUndefined();
  });
});

describe('firstEditableImage', () => {
  const base = {
    streamIndex: 0,
    start: 0,
    end: 0,
    name: 'Im1',
    ctm: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    rect: { x: 0, y: 0, width: 10, height: 10 },
    flipX: false,
    flipY: false,
    naturalWidth: 1,
    naturalHeight: 1,
    transformable: true,
  };

  it('skips a leading non-editable image to find the first editable one', () => {
    const blocked: LocatedImage = { ...base, editable: false, blockedReason: 'nope' };
    const editable: LocatedImage = { ...base, name: 'Im2', editable: true };

    expect(firstEditableImage([blocked, editable])).toBe(editable);
  });

  it('returns undefined when no image is editable', () => {
    const blocked: LocatedImage = { ...base, editable: false, blockedReason: 'nope' };
    expect(firstEditableImage([blocked])).toBeUndefined();
  });

  it('returns undefined for an empty page', () => {
    expect(firstEditableImage([])).toBeUndefined();
  });
});

describe('commitImageEdit (move)', () => {
  it('moves an image: the emitted matrix puts it at the requested rect', async () => {
    const { bytes } = await onePagePdfWithImage({ x: 100, y: 100, width: 50, height: 80 });
    const [image] = await locatePageImages(bytes, 0);

    const result = await commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image),
      action: { kind: 'move', rect: { x: 200, y: 300, width: 120, height: 40 } },
    });

    const [moved] = await locatePageImages(result, 0);
    expect(moved.rect.x).toBeCloseTo(200);
    expect(moved.rect.y).toBeCloseTo(300);
    expect(moved.rect.width).toBeCloseTo(120);
    expect(moved.rect.height).toBeCloseTo(40);
  });

  it('preserves the flip sign through a move (does not un-flip the image)', async () => {
    const { bytes } = await onePagePdfWithRawImageOp('-100 0 0 80 300 100 cm /Im1 Do');
    const [image] = await locatePageImages(bytes, 0);
    expect(image.flipX).toBe(true);

    const result = await commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image),
      action: { kind: 'move', rect: { x: 50, y: 50, width: 40, height: 20 } },
    });

    const [moved] = await locatePageImages(result, 0);
    expect(moved.flipX).toBe(true);
    expect(moved.rect.x).toBeCloseTo(50);
    expect(moved.rect.y).toBeCloseTo(50);
    expect(moved.rect.width).toBeCloseTo(40);
    expect(moved.rect.height).toBeCloseTo(20);
  });

  it('preserves z-order: the rewritten operator sits at the original byte position, not appended', async () => {
    const { bytes } = await onePagePdfWithImage(
      { x: 100, y: 100, width: 50, height: 80 },
      { markerText: 'AFTERMARKER' },
    );
    const [image] = await locatePageImages(bytes, 0);

    const result = await commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image),
      action: { kind: 'move', rect: { x: 10, y: 10, width: 5, height: 5 } },
    });

    const streams = await getPageContentStreams(result, 0);
    const decoded = streams.map(latin1).join('\n');
    expect(decoded.toUpperCase()).toContain(hex('AFTERMARKER'));

    // The rewritten Do (now wrapped in q ... cm ... Do Q) is still positioned
    // before the marker text's own Tj: the edit replaced bytes in place
    // rather than appending the new operator at the stream's end, which would
    // put it *after* the marker instead.
    const doIndex = decoded.indexOf(`/${image.name} Do`);
    const markerIndex = decoded.toUpperCase().indexOf(hex('AFTERMARKER'));
    expect(doIndex).toBeGreaterThan(-1);
    expect(doIndex).toBeLessThan(markerIndex);
  });

  it('refuses to move a rotated or skewed image', async () => {
    const { bytes } = await onePagePdfWithRawImageOp('0.866 0.5 -0.5 0.866 100 100 cm /Im1 Do');
    const [image] = await locatePageImages(bytes, 0);

    const promise = commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image),
      action: { kind: 'move', rect: { x: 0, y: 0, width: 10, height: 10 } },
    });
    await expect(promise).rejects.toBeInstanceOf(ImageEditError);
    await expect(promise).rejects.toMatchObject({ code: 'image-not-editable' });
  });

  it('rejects a target matching no image with image-not-found', async () => {
    const { bytes } = await onePagePdfWithImage({ x: 0, y: 0, width: 10, height: 10 });
    const promise = commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: { streamIndex: 0, name: 'DoesNotExist', rect: { x: 0, y: 0, width: 1, height: 1 } },
      action: { kind: 'move', rect: { x: 0, y: 0, width: 1, height: 1 } },
    });
    await expect(promise).rejects.toBeInstanceOf(ImageEditError);
    await expect(promise).rejects.toMatchObject({ code: 'image-not-found' });
  });
});

describe('commitImageEdit (replace)', () => {
  it('replaces an image, leaving the original XObject and a second page sharing it unaffected', async () => {
    const doc = await PDFDocument.create();
    const img = await doc.embedPng(PNG_1x1);
    const page0 = doc.addPage([595, 842]);
    page0.drawImage(img, { x: 100, y: 100, width: 50, height: 80 });
    const page1 = doc.addPage([595, 842]);
    page1.drawImage(img, { x: 100, y: 100, width: 50, height: 80 });
    const bytes = await doc.save();

    const [image0] = await locatePageImages(bytes, 0);
    const [image1] = await locatePageImages(bytes, 1);
    const originalRefOnPage0 = await xobjectRef(bytes, 0, image0.name);
    const originalRefOnPage1 = await xobjectRef(bytes, 1, image1.name);
    expect(originalRefOnPage0).toBeDefined();
    // Both pages drew the same embedded PDFImage, so they share one ref.
    expect(originalRefOnPage1).toBe(originalRefOnPage0);

    const result = await commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image0),
      action: { kind: 'replace', dataUrl: PNG_1x1, mime: 'image/png' },
    });

    const [afterPage0] = await locatePageImages(result, 0);
    // Page 0 now draws a freshly embedded image under a new resource name...
    expect(afterPage0.name).not.toBe(image0.name);
    expect(afterPage0.rect).toEqual(image0.rect);
    // ...but the OLD name is left alone on page 0, still resolving to the
    // exact original ref, not repointed or removed.
    expect(await xobjectRef(result, 0, image0.name)).toBe(originalRefOnPage0);
    // Page 1, which the edit never targeted, still resolves its own
    // same-named entry to the identical original ref too.
    expect(await xobjectRef(result, 1, image1.name)).toBe(originalRefOnPage1);
    const [afterPage1] = await locatePageImages(result, 1);
    expect(afterPage1.name).toBe(image1.name);
  });

  it('still allows replacing a rotated image in place, reusing its matrix untouched', async () => {
    const { bytes } = await onePagePdfWithRawImageOp('0.866 0.5 -0.5 0.866 100 100 cm /Im1 Do');
    const [image] = await locatePageImages(bytes, 0);

    const result = await commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image),
      action: { kind: 'replace', dataUrl: PNG_1x1, mime: 'image/png' },
    });

    const streams = await getPageContentStreams(result, 0);
    const decoded = streams.map(latin1).join('\n');
    // The matrix is reused byte-for-byte; only the operand name changed.
    expect(decoded).toContain('0.866 0.5 -0.5 0.866 100 100');
    expect(decoded).not.toContain('/Im1 Do');
  });
});

describe('commitImageEdit (delete)', () => {
  it('deletes an image, leaving the rest of the page content intact', async () => {
    const { bytes } = await onePagePdfWithImage(
      { x: 100, y: 100, width: 50, height: 80 },
      { markerText: 'KEEPME' },
    );
    const [image] = await locatePageImages(bytes, 0);

    const result = await commitImageEdit({
      pdfBytes: bytes,
      pageIndex: 0,
      target: targetFor(image),
      action: { kind: 'delete' },
    });

    expect(await locatePageImages(result, 0)).toHaveLength(0);
    const streams = await getPageContentStreams(result, 0);
    expect(streams.map(latin1).join('\n').toUpperCase()).toContain(hex('KEEPME'));
  });
});

describe('commitImageEdit (images inside a Form XObject)', () => {
  it('refuses every action on an image found inside a form', async () => {
    const { bytes } = await pdfWithImageInForm();
    const [image] = await locatePageImages(bytes, 0);
    const target = targetFor(image);

    await expect(
      commitImageEdit({ pdfBytes: bytes, pageIndex: 0, target, action: { kind: 'delete' } }),
    ).rejects.toMatchObject({ code: 'image-not-editable' });
    await expect(
      commitImageEdit({
        pdfBytes: bytes,
        pageIndex: 0,
        target,
        action: { kind: 'move', rect: { x: 0, y: 0, width: 10, height: 10 } },
      }),
    ).rejects.toMatchObject({ code: 'image-not-editable' });
    await expect(
      commitImageEdit({
        pdfBytes: bytes,
        pageIndex: 0,
        target,
        action: { kind: 'replace', dataUrl: PNG_1x1, mime: 'image/png' },
      }),
    ).rejects.toMatchObject({ code: 'image-not-editable' });
  });
});
