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
// image, OCR, sign, digitally sign, save, find, dark scheme, theme, About). It
// used to keep a fixed ~1345px intrinsic width — the filename never truncated and
// the auto-scroll speed slot reserved 104px even when idle — so on a narrow or
// high-DPI-scaled window the last controls spilled off the right edge and were
// clipped. This guards that the toolbar fits its own width and every control
// stays on-screen.
test('toolbar keeps all controls on-screen on a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto('/');
  await openFixture(page);

  const toolbar = page.locator('.folio-toolbar');
  const overflow = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, 'toolbar content overflows its own width').toBeLessThanOrEqual(1);

  // The last right-hand control must be fully within the viewport.
  const about = page.getByRole('button', { name: /about folio/i });
  const box = await about.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width, 'About button is clipped by the window edge').toBeLessThanOrEqual(
    1025,
  );
});
