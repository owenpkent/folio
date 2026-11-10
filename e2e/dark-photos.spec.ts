import { expect, test, type Page } from '@playwright/test';

/**
 * Dark mode keeps photos in their own colours (src/core/pdf/darkPhotos.ts), in
 * a real browser, where images reach PDF.js as ImageBitmaps and transfer maps
 * (/TR) run as canvas filters: neither happens in the Node tests.
 */

/** Latin-1 bytes of hand-written PDF source (no xref: PDF.js rebuilds it). */
function pdfBytes(objects: string[]): Buffer {
  const body = objects.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join('');
  return Buffer.from(
    `%PDF-1.7\n${body}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\n%%EOF\n`,
    'latin1',
  );
}

function stream(dict: string, body: string): string {
  return `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`;
}

const rgbImage = (rgb: string) =>
  stream(
    '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8',
    rgb.repeat(4),
  );

/** Where the four grey copies sit (x of each 30 x 30 tile, at y 10..40). */
const COPIES = [10, 50, 90, 130];

/**
 * A 200 x 200 page: a red photo, then four identical grey (64) copies under a
 * squaring transfer function, which PDF.js batches into one repeated-image
 * paint. Under the transfer map grey 64 shows as 16.
 */
const TRANSFER_PDF = pdfBytes([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ' +
    '/Resources << /XObject << /Red 5 0 R /Grey 6 0 R >> ' +
    '/ExtGState << /Sq << /TR << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 2 >> >> >> >> >>',
  stream(
    '',
    'q 60 0 0 60 70 110 cm /Red Do Q /Sq gs ' +
      COPIES.map((x) => `q 30 0 0 30 ${x} 10 cm /Grey Do Q`).join(' '),
  ),
  rgbImage('\xff\x00\x00'),
  rgbImage('\x40\x40\x40'),
]);

async function openPdf(page: Page, theme: 'light' | 'night' | 'amber'): Promise<void> {
  await page.addInitScript((t) => {
    localStorage.setItem('folio.theme', t === 'light' ? 'light' : 'dark');
    if (t !== 'light') localStorage.setItem('folio.darkScheme', t);
  }, theme);
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('.folio-empty')
      .getByRole('button', { name: /open document/i })
      .click(),
  ]);
  await chooser.setFiles({
    name: 'transfer.pdf',
    mimeType: 'application/pdf',
    buffer: TRANSFER_PDF,
  });
}

/** RGB at PDF user-space points (y up) on the first page's canvas. */
function sample(page: Page, points: [number, number][]): Promise<number[][]> {
  return page
    .locator('.folio-page-canvas')
    .first()
    .evaluate((el, pts) => {
      const canvas = el as HTMLCanvasElement;
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0) return [];
      return pts.map(([x, y]) => {
        const px = Math.floor((x / 200) * canvas.width);
        const py = Math.floor(((200 - y) / 200) * canvas.height);
        return Array.from(context.getImageData(px, py, 1, 1).data.slice(0, 3));
      });
    }, points);
}

const BACKGROUND: [number, number] = [190, 190];
const RED_CENTRE: [number, number] = [100, 140];
const copyCentres = COPIES.map((x): [number, number] => [x + 15, 25]);

const near = (a: number[], b: number[], tolerance = 4) =>
  a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tolerance);

for (const theme of ['light', 'night', 'amber'] as const) {
  test(`${theme}: repeated images under a transfer map all match, photos keep colour`, async ({
    page,
  }) => {
    await openPdf(page, theme);
    const background = theme === 'light' ? [255, 255, 255] : [0, 0, 0];
    // Rendered (and, in dark mode, inverted) once the page background is right.
    await expect
      .poll(async () => near((await sample(page, [BACKGROUND]))[0] ?? [], background))
      .toBe(true);

    const [red, ...copies] = await sample(page, [RED_CENTRE, ...copyCentres]);
    // Night shows the photo as it is; Amber multiplies it by the tint.
    expect(near(red, theme === 'amber' ? [240, 0, 0] : [255, 0, 0], 6)).toBe(true);
    // Every copy alike, batched or not; in light and Night, the transfer map's
    // 16, which Amber then tints.
    for (const copy of copies) expect(near(copy, copies[0], 3), `${copies}`).toBe(true);
    if (theme !== 'amber') expect(near(copies[0], [16, 16, 16], 4), `${copies[0]}`).toBe(true);
  });
}
