import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { ADDRESSES, ADDRESSES_PAGE } from './global-setup';

const ADDRESSES_PDF = resolve('e2e/fixtures/addresses.pdf');

async function openFixture(page: Page) {
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('.folio-empty')
      .getByRole('button', { name: /open document/i })
      .click(),
  ]);
  await chooser.setFiles(ADDRESSES_PDF);
  await expect(page.locator('.folio-page-canvas').first()).toBeVisible();
}

/**
 * Right-click at a point in PDF user space.
 *
 * Aiming through the geometry rather than at a text-layer span keeps the test
 * measuring what the feature does (hit-test a point against the page) instead
 * of how PDF.js happens to lay its spans out.
 */
async function rightClickAt(page: Page, pdfX: number, pdfY: number) {
  const box = (await page.locator('.folio-page').first().boundingBox())!;
  const scale = box.width / ADDRESSES_PAGE.width;
  await page.mouse.click(box.x + pdfX * scale, box.y + (ADDRESSES_PAGE.height - pdfY) * scale, {
    button: 'right',
  });
  await expect(page.getByRole('menu', { name: 'Document actions' })).toBeVisible();
}

const menuItem = (page: Page, name: string) =>
  page.getByRole('menu', { name: 'Document actions' }).getByRole('menuitem', { name });

test.describe('copying addresses', () => {
  test.beforeEach(async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openFixture(page);
  });

  test('copies an email address printed in the page', async ({ page }) => {
    // A few points above the baseline, so the click lands on the glyphs.
    await rightClickAt(page, ADDRESSES.email.x + 30, ADDRESSES.email.y + 5);

    const item = menuItem(page, /Copy email address/);
    await expect(item).toBeVisible();
    await expect(item).toContainText(ADDRESSES.email.text);

    await item.click();
    await expect(page.locator('.folio-sr-only[aria-live="polite"]')).toContainText(
      'Copied email address',
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADDRESSES.email.text);
  });

  test('copies a web address printed in the page', async ({ page }) => {
    await rightClickAt(page, ADDRESSES.url.x + 30, ADDRESSES.url.y + 5);

    const item = menuItem(page, /Copy link address/);
    await expect(item).toBeVisible();

    await item.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADDRESSES.url.text);
  });

  test('copies what a link annotation actually points at, not what it says', async ({ page }) => {
    const [x0, y0, x1, y1] = ADDRESSES.link.rect;
    await rightClickAt(page, (x0 + x1) / 2, (y0 + y1) / 2);

    const item = menuItem(page, /Copy link address/);
    // The menu shows the declared target, which is the whole point: nothing
    // printed on the page says where this link goes.
    await expect(item).toContainText(ADDRESSES.link.target);
    await expect(item).not.toContainText('Click here');

    await item.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ADDRESSES.link.target);
  });

  test('offers nothing to copy on blank space', async ({ page }) => {
    // Well right of every address, and high enough on the page to still be in
    // the window at fit-width, where this page is several screens tall.
    await rightClickAt(page, 350, 540);

    await expect(menuItem(page, /Copy email address/)).toHaveCount(0);
    await expect(menuItem(page, /Copy link address/)).toHaveCount(0);
    // The rest of the menu is unaffected.
    await expect(menuItem(page, /^Copy$/)).toBeVisible();
  });
});
