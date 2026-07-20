import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');

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

test('nothing collapses into the overflow menu on a wide window', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto('/');
  await openFixture(page);

  await expect(page.getByRole('button', { name: 'More tools' })).toHaveCount(0);
  // A representative document tool is directly on the toolbar, not in a menu.
  await expect(page.getByRole('button', { name: /^Find/ })).toBeVisible();
});
