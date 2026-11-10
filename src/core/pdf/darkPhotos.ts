/**
 * Dark mode without negative photos.
 *
 * Dark mode inverts the finished page (see {@link invertPage}). To keep photos
 * and figures in their own colours, each one is inverted as PDF.js draws it,
 * so the page-wide invert flips it back. Done at draw time, so everything PDF.js
 * does around the image still applies: clipping paths, soft masks and alpha,
 * transparency groups and their offscreen canvases, and whatever is painted on
 * top. For an image drawn with alpha `a` over a backdrop `B`, the page shows
 * `a * image + (1 - a) * invert(B)`: the photo as is, over the dark page.
 * Every image is kept, scans included: a scanned page stays as scanned.
 *
 * PDF.js has no public hook for this, so it wraps four methods on the render's
 * private CanvasGraphics instance (`renderTask._internalRenderTask.gfx`, pinned
 * against pdfjs-dist 6.4.299 by darkPhotos.test.ts). If that shape ever
 * changes, the hook steps aside and photos are inverted with the page, the way
 * they were before.
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Invert the finished page in place, then multiply by the reading tint. */
export function invertPage(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  tint?: [number, number, number],
): void {
  // `difference` with white computes |255 - channel| per pixel, exactly
  // invert(1), but on the real canvas, so it never triggers the CSS-filter path
  // that some engines re-rasterise at CSS resolution (blur).
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'difference';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  // A green/amber reading scheme: multiply the inverted page by the tint so the
  // (now white) ink takes the colour while black stays black. Multiply scales
  // each channel, so anti-aliased edges become a gradient of the tint rather
  // than a hard mask.
  if (tint) {
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = `rgb(${tint[0]}, ${tint[1]}, ${tint[2]})`;
    context.fillRect(0, 0, width, height);
  }
  context.restore();
}

/**
 * Invert each pixel's colour and leave its alpha alone, then multiply by the
 * tint. Per pixel rather than difference-with-white because that composite
 * would turn transparency opaque white.
 */
export function invertPixels(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  tint?: [number, number, number],
): void {
  if (width === 0 || height === 0) return;
  const image = context.getImageData(0, 0, width, height);
  const px = image.data;
  const [r, g, b] = tint ?? [255, 255, 255];
  for (let i = 0; i < px.length; i += 4) {
    px[i] = ((255 - px[i]) * r) / 255;
    px[i + 1] = ((255 - px[i + 1]) * g) / 255;
    px[i + 2] = ((255 - px[i + 2]) * b) / 255;
  }
  context.putImageData(image, 0, 0);
}

/**
 * Invert an image's colours in place, keeping its alpha. Through a canvas
 * filter where the engine has them (Chromium and WebView2, Firefox, Safari
 * 18+), which stays on the GPU: the same filtered self-draw PDF.js uses for
 * transfer maps, with `copy` so transparent pixels are replaced rather than
 * drawn over. Otherwise per pixel, which reads the image back to the CPU.
 */
function invertImage(context: CanvasRenderingContext2D, width: number, height: number): void {
  // PDF.js's own test (FeatureTest.isCanvasFilterSupported): engines without
  // canvas filters have no such property.
  if (context.filter === undefined) {
    invertPixels(context, width, height);
    return;
  }
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'copy';
  context.filter = 'invert(1)';
  context.drawImage(context.canvas, 0, 0);
  context.restore();
}

interface CanvasEntry {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
}

/** What PDF.js hands its image painters: decoded pixels or a bitmap. */
interface ImageObject {
  width: number;
  height: number;
  bitmap?: CanvasImageSource;
}

/** The parts of PDF.js's private CanvasGraphics this file relies on. */
interface Graphics {
  ctx: CanvasRenderingContext2D;
  canvasFactory: {
    create(width: number, height: number): CanvasEntry;
    destroy(entry: CanvasEntry): void;
  };
  /** Non-empty while the content of a soft mask is being drawn. */
  smaskStack: unknown[];
  current: { transferMapsFallback: unknown };
  paintInlineImageXObject(opIdx: number, image: ImageObject): void;
  paintInlineImageXObjectGroup(
    opIdx: number,
    image: ImageObject,
    map: { transform: number[] }[],
  ): void;
  applyTransferMapsToBitmap(image: ImageObject): {
    img: CanvasImageSource;
    canvasEntry: CanvasEntry | null;
  };
  applyTransferMapsToCanvas(context: CanvasRenderingContext2D): HTMLCanvasElement;
  [op: number]: unknown;
}

const HOOKED = [
  'paintInlineImageXObject',
  'paintInlineImageXObjectGroup',
  'applyTransferMapsToBitmap',
  'applyTransferMapsToCanvas',
] as const;

function isGraphics(value: unknown): value is Graphics {
  const gfx = value as Partial<Graphics> | null | undefined;
  return (
    !!gfx &&
    !!gfx.ctx &&
    !!gfx.canvasFactory &&
    Array.isArray(gfx.smaskStack) &&
    HOOKED.every((name) => typeof gfx[name] === 'function')
  );
}

/**
 * Have `task` keep photos in their own colours through the page invert that
 * follows it.
 *
 * The graphics object exists only once the page's resources are ready, so this
 * takes the first `onContinue` call, which PDF.js makes before it draws
 * anything. The result's `hooked` says whether the hook took (for tests).
 */
export function keepPhotoColours(task: pdfjsLib.RenderTask): { readonly hooked: boolean } {
  const state = { hooked: false };
  let tried = false;
  task.onContinue = (cont: () => void) => {
    if (!tried) {
      tried = true;
      const gfx = (task as unknown as { _internalRenderTask?: { gfx?: unknown } })
        ._internalRenderTask?.gfx;
      if (isGraphics(gfx)) {
        hookPhotos(gfx);
        state.hooked = true;
      } else if (import.meta.env.DEV) {
        console.warn('[folio] dark mode: PDF.js internals changed; photos will be inverted');
      }
    }
    cont();
  };
  return state;
}

function hookPhotos(gfx: Graphics): void {
  const paint = gfx.paintInlineImageXObject;
  const paintGroup = gfx.paintInlineImageXObjectGroup;
  const toBitmap = gfx.applyTransferMapsToBitmap;
  const toCanvas = gfx.applyTransferMapsToCanvas;
  // Set for the length of one image paint; read by the transfer-map hooks,
  // which is where every photo's pixels pass on their way to the canvas.
  let photo = false;

  // Inside a soft mask the image is the mask, not something on the page.
  const isPhoto = (): boolean => gfx.smaskStack.length === 0;

  const invertedCopy = (source: CanvasImageSource, width: number, height: number) => {
    const entry = gfx.canvasFactory.create(width, height);
    entry.context.drawImage(source, 0, 0);
    invertImage(entry.context, width, height);
    return entry;
  };

  gfx.paintInlineImageXObject = function (this: Graphics, opIdx, image) {
    photo = isPhoto();
    try {
      paint.call(this, opIdx, image);
    } finally {
      photo = false;
    }
  };

  gfx.paintInlineImageXObjectGroup = function (this: Graphics, opIdx, image, map) {
    photo = isPhoto();
    let copy: CanvasEntry | null = null;
    let filter: string | undefined;
    try {
      // This painter draws a bitmap straight from the image object, with any
      // transfer map (/TR) still on the context as a filter, so it would land
      // after the inversion; the single-image painter applies it to the pixels
      // first. Do it in that order here too, through the hooked
      // applyTransferMapsToBitmap below (transfer map, then invert, into a
      // canvas of its own), and take the filter off for the draw.
      if (photo && image.bitmap && !this.current.transferMapsFallback) {
        const { img, canvasEntry } = this.applyTransferMapsToBitmap(image);
        copy = canvasEntry;
        image = { ...image, bitmap: img };
        if (this.ctx.filter !== undefined) {
          filter = this.ctx.filter;
          this.ctx.filter = 'none';
        }
      }
      paintGroup.call(this, opIdx, image, map);
    } finally {
      photo = false;
      if (filter !== undefined) this.ctx.filter = filter;
      if (copy) this.canvasFactory.destroy(copy);
    }
  };

  gfx.applyTransferMapsToBitmap = function (this: Graphics, image) {
    const result = toBitmap.call(this, image);
    if (!photo) return result;
    // A canvas of PDF.js's own, made for this paint and destroyed after it.
    if (result.canvasEntry) {
      const { canvas, context } = result.canvasEntry;
      invertImage(context, canvas.width, canvas.height);
      return result;
    }
    // The decoded bitmap itself, shared and cached: never touch it.
    const copy = invertedCopy(result.img, image.width, image.height);
    return { img: copy.canvas, canvasEntry: copy };
  };

  gfx.applyTransferMapsToCanvas = function (this: Graphics, context) {
    // Always a scratch canvas holding this paint's decoded pixels.
    const canvas = toCanvas.call(this, context);
    if (photo) invertImage(context, canvas.width, canvas.height);
    return canvas;
  };

  // Operators dispatch by number through the prototype (`this[fnId]`), so the
  // inline-image ops need the instance overrides under their numbers too. The
  // image-XObject ops reach the painters by name and pick them up already.
  gfx[pdfjsLib.OPS.paintInlineImageXObject] = gfx.paintInlineImageXObject;
  gfx[pdfjsLib.OPS.paintInlineImageXObjectGroup] = gfx.paintInlineImageXObjectGroup;
}
