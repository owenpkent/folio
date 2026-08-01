import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');

/**
 * Print's unit tests mock `pdfjs-dist`, so by construction they cannot see
 * anything about the *real* PDF.js: not which build is imported, not whether
 * its worker is configured, not what the rasterised pages measure. Both bugs
 * this file now guards shipped green through those tests.
 *
 * Everything here stubs `window.print` rather than calling it. The assertion is
 * about what reaches the print dialog, and a real dialog is a modal that would
 * hang the run.
 */

async function openFixture(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('.folio-empty')
      .getByRole('button', { name: /open document/i })
      .click(),
  ]);
  await chooser.setFiles(FORM_PDF);
  await expect(page.locator('.folio-page-canvas').first()).toBeVisible();
}

/** Replace print() with a recorder, then take the File > Print… path. */
async function printAndCapture(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __printCalls: number }).__printCalls = 0;
    window.print = () => {
      (window as unknown as { __printCalls: number }).__printCalls += 1;
    };
  });

  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: /^Print/ }).click();

  await page.waitForFunction(
    () => (window as unknown as { __printCalls: number }).__printCalls > 0,
    null,
    { timeout: 60_000 },
  );
}

test('print rasterises every page and hands them to the dialog', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);
  const pageCount = await page.locator('.folio-page').count();
  expect(pageCount).toBe(2);

  await printAndCapture(page);

  // One image per document page, each actually decoded. A zero natural size is
  // what a page that failed to rasterise looks like, and it would otherwise
  // reach the printer as a blank sheet.
  const images = await page.evaluate(() =>
    [...document.querySelectorAll('#folio-print-root img')].map((el) => ({
      w: (el as HTMLImageElement).naturalWidth,
      h: (el as HTMLImageElement).naturalHeight,
    })),
  );
  expect(images).toHaveLength(pageCount);
  for (const img of images) {
    expect(img.w).toBeGreaterThan(0);
    expect(img.h).toBeGreaterThan(0);
  }

  // The rule that reveals the print root is keyed on this class, not on the
  // root existing.
  await expect
    .poll(() => page.evaluate(() => document.body.classList.contains('folio-printing')))
    .toBe(true);
});

test('a filled field is baked into the printed raster, not just the DOM overlay', async ({
  page,
}) => {
  await page.goto('/');
  await openFixture(page);

  // Field values live in an overlay <input> above the canvas; the canvas itself
  // is deliberately free of them. Printing the canvas would therefore hand back
  // the empty form, which is the failure this whole code path exists to avoid.
  const field = page.locator('.folio-forms-layer input').first();
  await field.fill('Owen Kent');
  await field.blur();

  const ink = async () => {
    await printAndCapture(page);
    return page.evaluate(() => {
      const roots = document.querySelectorAll('#folio-print-root');
      const img = roots[roots.length - 1]?.querySelector('img') as HTMLImageElement | null;
      if (!img) return -1;
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const { data } = g.getImageData(0, 0, c.width, c.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128) dark++;
      }
      // Roots are torn down on `afterprint`, which a stubbed print() never
      // fires, so drop them by hand before the next run measures a stale one.
      document.querySelectorAll('#folio-print-root').forEach((r) => r.remove());
      document.body.classList.remove('folio-printing');
      return dark;
    });
  };

  const withValue = await ink();

  await field.fill('');
  await field.blur();
  const withoutValue = await ink();

  expect(withValue).toBeGreaterThan(0);
  expect(withoutValue).toBeGreaterThan(0);
  // The only difference between the two runs is the typed value, so the extra
  // ink is that value rendered onto the page.
  expect(withValue).toBeGreaterThan(withoutValue);
});
