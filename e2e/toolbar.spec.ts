import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');

async function openPath(page: Page, file: string) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('.folio-empty')
      .getByRole('button', { name: /open document/i })
      .click(),
  ]);
  await chooser.setFiles(file);
  await expect(page.locator('.folio-page-canvas').first()).toBeVisible();
}

async function openFixture(page: Page) {
  await openPath(page, FORM_PDF);
}

/** A minimal N-page PDF, written to a temp file, so the page indicator reads
 *  "1 / N" with a multi-digit total — the shape that exposed the wrap bug. */
async function makePagesPdf(pageCount: number): Promise<string> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 72, y: 700, size: 24 });
  }
  const bytes = await doc.save();
  const path = join(mkdtempSync(join(tmpdir(), 'folio-pagebox-')), `p${pageCount}.pdf`);
  writeFileSync(path, bytes);
  return path;
}

// The toolbar carries a crowded right-hand group (comment, highlight, edit, text,
// image, OCR, sign, digitally sign, save, find, …). It used to keep a fixed
// ~1345px intrinsic width, so on a narrow or high-DPI-scaled window the last
// controls spilled off the right edge and were clipped. Tools that don't fit now
// collapse into a "More" (⋯) overflow menu; the toolbar never overflows.
test('toolbar keeps all controls on-screen on a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');
  await openFixture(page);

  const toolbar = page.locator('.folio-toolbar');
  const overflow = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, 'toolbar content overflows its own width').toBeLessThanOrEqual(1);

  // The About control is pinned, so it stays on-screen at any width.
  const about = page.getByRole('button', { name: /about folio/i });
  const box = await about.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width, 'About button is clipped by the window edge').toBeLessThanOrEqual(
    1025,
  );
});

test('overflowing tools collapse into a reachable "More" menu when very narrow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto('/');
  await openFixture(page);

  // No horizontal clipping even at 700px wide.
  const overflow = await page
    .locator('.folio-toolbar')
    .evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // The pinned About control is still directly visible.
  await expect(page.getByRole('button', { name: /about folio/i })).toBeVisible();

  // The tools that don't fit are reachable through the overflow menu.
  const more = page.getByRole('button', { name: 'More tools' });
  await expect(more).toBeVisible();
  await more.click();
  const menu = page.getByRole('menu', { name: 'More tools' });
  await expect(menu.getByRole('menuitem', { name: 'Find' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Save a copy' })).toBeVisible();
});

// Regression: the page indicator renders "/ {numPages}" as text with a space
// between "/" and the count. When the pagebox was allowed to shrink inside the
// flex-1 center group, a squeezed toolbar wrapped that space — "/" landing above
// "18", and align-items:center then mis-centering the page input against the
// two-line block. The pagebox is now flex:0 0 auto + white-space:nowrap, so the
// indicator must stay a single line at any width.
test('page indicator stays on one line when the toolbar is squeezed', async ({ page }) => {
  const pdf = await makePagesPdf(18);
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/');
  await openPath(page, pdf);

  const total = page.locator('.folio-pagebox__total');
  await expect(total).toHaveText('/ 18');

  // A wrapped "/ 18" doubles the span's height; a single line stays within one
  // line-height (× 1.6 absorbs sub-pixel rounding without admitting a second row).
  const box = await total.boundingBox();
  const lineHeight = await total.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect(box).not.toBeNull();
  expect(box!.height, '"/ 18" wrapped to a second line').toBeLessThan(lineHeight * 1.6);
});

// The toolbar is a fixed-height single row. The horizontal guard above checks it
// never scrolls sideways; this is its vertical twin — content must never grow the
// bar past its configured height or spill below it (a wrapped or oversized control
// would). Complements the single-line check above, which pins the pagebox itself.
test('toolbar never grows past its fixed height when squeezed', async ({ page }) => {
  const pdf = await makePagesPdf(18);
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/');
  await openPath(page, pdf);

  const toolbar = page.locator('.folio-toolbar');
  const vOverflow = await toolbar.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(vOverflow, 'toolbar content overflows its fixed height').toBeLessThanOrEqual(1);

  // The bar stays at its configured 48px (tokens.css --folio-toolbar-height).
  const box = await toolbar.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height, 'toolbar height drifted from its fixed value').toBeLessThanOrEqual(49);
});

test('nothing collapses into the overflow menu on a wide window', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto('/');
  await openFixture(page);

  await expect(page.getByRole('button', { name: 'More tools' })).toHaveCount(0);
  // A representative document tool is directly on the toolbar, not in a menu.
  await expect(page.getByRole('button', { name: /^Find/ })).toBeVisible();
});
