// @vitest-environment node
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCanvas } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { invertPage, keepPhotoColours } from './darkPhotos';

/**
 * Dark mode against real PDF.js (and a real canvas, @napi-rs/canvas, which is
 * what PDF.js itself uses under Node). These pin the private CanvasGraphics
 * shape darkPhotos.ts hooks, and the pixels around a photo: the hook must not
 * change anything outside what the image actually painted.
 */

const require = createRequire(import.meta.url);
const wasmUrl =
  pathToFileURL(join(dirname(require.resolve('pdfjs-dist/package.json')), 'wasm')).href + '/';

const SIZE = 200;
const RED = [255, 0, 0];
const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];
const AMBER: [number, number, number] = [240, 185, 80];

/** Latin-1 bytes of hand-written PDF source (no xref: PDF.js rebuilds it). */
function bytesOf(source: string): Uint8Array {
  return Uint8Array.from(source, (c) => c.charCodeAt(0));
}

function stream(dict: string, body: string): string {
  return `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

/** Raw (unfiltered) RGB image of 2x2 red pixels. */
const RED_IMAGE = stream(
  '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8',
  '\xff\x00\x00'.repeat(4),
);

/**
 * A 200 x 200 page with `content`, whose resources are `resources`, plus any
 * extra numbered objects (from 5 on) the resources refer to.
 */
function pagePdf(content: string, resources: string, extra: string[] = []): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SIZE} ${SIZE}] /Resources ${resources} /Contents 4 0 R >>`,
    stream('', content),
    ...extra,
  ];
  const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('');
  return bytesOf(
    `%PDF-1.7\n${body}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF\n`,
  );
}

interface Rendered {
  hooked: boolean;
  /** RGB at PDF user-space (x, y), y up. */
  at(x: number, y: number): number[];
}

interface DecodedImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8ClampedArray;
  bitmap?: unknown;
}

/**
 * Browsers usually get images from the worker as ImageBitmaps; Node gets raw
 * pixels. Turn an RGB image into a canvas (which PDF.js draws the same way as
 * a bitmap) so the bitmap branches run too.
 */
function asBitmap(image: DecodedImage): DecodedImage {
  if (image.bitmap || !image.data) return image;
  if (image.kind !== pdfjsLib.ImageKind.RGB_24BPP) throw new Error('fixture images are RGB');
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  const rgba = context.createImageData(image.width, image.height);
  for (let i = 0, j = 0; i < image.data.length; i += 3, j += 4) {
    rgba.data.set(image.data.subarray(i, i + 3), j);
    rgba.data[j + 3] = 255;
  }
  context.putImageData(rgba, 0, 0);
  return { width: image.width, height: image.height, bitmap: canvas };
}

type Painter = (this: unknown, opIdx: number, image: DecodedImage, ...rest: unknown[]) => void;

/** Wrap the (already hooked) painters so images reach them as bitmaps. */
function feedBitmaps(task: pdfjsLib.RenderTask): void {
  const hooked = task.onContinue as (cont: () => void) => void;
  let wrapped = false;
  task.onContinue = (cont: () => void) =>
    hooked(() => {
      if (!wrapped) {
        wrapped = true;
        const gfx = (task as unknown as { _internalRenderTask: { gfx: Record<string, Painter> } })
          ._internalRenderTask.gfx;
        for (const name of ['paintInlineImageXObject', 'paintInlineImageXObjectGroup']) {
          const paint = gfx[name];
          gfx[name] = function (opIdx, image, ...rest) {
            paint.call(this, opIdx, asBitmap(image), ...rest);
          };
        }
      }
      cont();
    });
}

async function renderDark(
  bytes: Uint8Array,
  tint?: [number, number, number],
  { bitmaps = false } = {},
): Promise<Rendered> {
  const loading = pdfjsLib.getDocument({ data: bytes.slice(), wasmUrl, verbosity: 0 });
  const doc = await loading.promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const task = page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport });
    const hook = keepPhotoColours(task);
    if (bitmaps) feedBitmaps(task);
    await task.promise;
    const context = canvas.getContext('2d');
    invertPage(context as unknown as CanvasRenderingContext2D, canvas.width, canvas.height, tint);
    return {
      hooked: hook.hooked,
      at: (x, y) => Array.from(context.getImageData(x, SIZE - y, 1, 1).data.slice(0, 3)),
    };
  } finally {
    await loading.destroy();
  }
}

function expectColour(actual: number[], expected: number[], tolerance = 4): void {
  actual.forEach((channel, i) =>
    expect(Math.abs(channel - expected[i])).toBeLessThanOrEqual(tolerance),
  );
}

/**
 * Hide canvas filters the way an engine without them looks (no `filter`
 * property at all), so the per-pixel fallback runs instead of the GPU path.
 */
function withoutCanvasFilters(): void {
  const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d')) as object;
  const original = Object.getOwnPropertyDescriptor(proto, 'filter');
  beforeAll(() => {
    Object.defineProperty(proto, 'filter', {
      configurable: true,
      get: () => undefined,
      set: () => {},
    });
  });
  afterAll(() => {
    if (original) Object.defineProperty(proto, 'filter', original);
    else delete (proto as { filter?: unknown }).filter;
  });
}

describe.each([
  ['through a canvas filter', false],
  ['per pixel, without canvas filters', true],
])('dark mode keeps photos in their own colours (%s)', (_label, noFilters) => {
  if (noFilters) withoutCanvasFilters();

  it('leaves a photo as it is on an inverted page', async () => {
    const page = await renderDark(
      pagePdf('q 80 0 0 80 50 50 cm /Im Do Q', '<< /XObject << /Im 5 0 R >> >>', [RED_IMAGE]),
    );

    expect(page.hooked).toBe(true);
    expectColour(page.at(90, 90), RED);
    expectColour(page.at(20, 20), BLACK);
  });

  it('leaves a photo as it is when it arrives as a bitmap', async () => {
    const page = await renderDark(
      pagePdf('q 80 0 0 80 50 50 cm /Im Do Q', '<< /XObject << /Im 5 0 R >> >>', [RED_IMAGE]),
      undefined,
      { bitmaps: true },
    );

    expectColour(page.at(90, 90), RED);
    expectColour(page.at(20, 20), BLACK);
  });

  it('handles a repeated image, which PDF.js paints as one group', async () => {
    // Four identical draws in a row become a single paintImageXObjectRepeat.
    const tiles = [10, 50, 90, 130].map((x) => `q 30 0 0 30 ${x} 10 cm /Im Do Q`).join(' ');
    const pdf = pagePdf(tiles, '<< /XObject << /Im 5 0 R >> >>', [RED_IMAGE]);

    for (const bitmaps of [false, true]) {
      const page = await renderDark(pdf, undefined, { bitmaps });
      expectColour(page.at(25, 25), RED);
      expectColour(page.at(145, 25), RED);
      expectColour(page.at(45, 25), BLACK);
    }
  });

  it('does the same for an inline image', async () => {
    const inline = `q 80 0 0 80 50 50 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ${'\xff\x00\x00'.repeat(4)} EI Q`;
    const page = await renderDark(pagePdf(inline, '<< >>'));

    expectColour(page.at(90, 90), RED);
    expectColour(page.at(20, 20), BLACK);
  });

  it('keeps a page-sized image (a scan) as it is too', async () => {
    const page = await renderDark(
      pagePdf('q 200 0 0 200 0 0 cm /Im Do Q', '<< /XObject << /Im 5 0 R >> >>', [RED_IMAGE]),
    );

    expectColour(page.at(100, 100), RED);
  });

  it('finds a photo inside an offscreen transparency group, and nothing else', async () => {
    const form = stream(
      '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Group << /S /Transparency /I true >> /Resources << /XObject << /Im 6 0 R >> >>',
      'q 60 0 0 60 100 50 cm /Im Do Q',
    );
    const page = await renderDark(
      pagePdf(
        '/Half gs /Fm Do',
        '<< /XObject << /Fm 5 0 R >> /ExtGState << /Half << /ca 0.5 >> >> >>',
        [form, RED_IMAGE],
      ),
    );

    // Half red over the dark page: the photo at half strength, not its negative.
    expectColour(page.at(130, 80), [128, 0, 0]);
    // Far from the image: untouched page, so dark.
    expectColour(page.at(20, 180), BLACK);
  });

  it('respects a clipping path: content outside the clip stays inverted', async () => {
    const circle =
      '130 90 m 130 112.09 112.09 130 90 130 c 67.91 130 50 112.09 50 90 c ' +
      '50 67.91 67.91 50 90 50 c 112.09 50 130 67.91 130 90 c h W n';
    const content = `0 0 0 rg 0 52 200 8 re f q ${circle} 80 0 0 80 50 50 cm /Im Do Q`;
    const pdf = pagePdf(content, '<< /XObject << /Im 5 0 R >> >>', [RED_IMAGE]);

    const night = await renderDark(pdf);
    expectColour(night.at(90, 90), RED);
    // Inside the image's box, outside the circle: the black rule, inverted.
    expectColour(night.at(55, 55), WHITE);
    // And the corner of the box above the rule is plain dark page.
    expectColour(night.at(53, 127), BLACK);

    const amber = await renderDark(pdf, AMBER);
    expectColour(amber.at(55, 55), AMBER);
  });

  it('respects an image soft mask: transparent parts show the dark page', async () => {
    const masked = stream(
      '/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R',
      '\xff\x00\x00\xff\x00\x00',
    );
    const alpha = stream(
      '/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
      '\xff\x00',
    );
    const page = await renderDark(
      pagePdf('q 80 0 0 80 50 50 cm /Im Do Q', '<< /XObject << /Im 5 0 R >> >>', [masked, alpha]),
    );

    expectColour(page.at(60, 90), RED);
    expectColour(page.at(120, 90), BLACK);
  });

  it('leaves an image that is part of a soft mask alone', async () => {
    // A blue square seen through a luminosity mask drawn with a white image.
    // Inverting the mask's image would black the mask out and hide the square.
    const white = stream(
      '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8',
      '\xff',
    );
    const maskForm = stream(
      '/Type /XObject /Subtype /Form /BBox [0 0 200 200] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /XObject << /W 5 0 R >> >>',
      'q 80 0 0 80 50 50 cm /W Do Q',
    );
    const page = await renderDark(
      pagePdf(
        '/Masked gs 0 0 1 rg 50 50 80 80 re f',
        '<< /ExtGState << /Masked << /SMask << /S /Luminosity /G 6 0 R >> >> >> >>',
        [white, maskForm],
      ),
    );

    // Blue, inverted with the page like any vector fill.
    expectColour(page.at(90, 90), [255, 255, 0]);
  });
});
