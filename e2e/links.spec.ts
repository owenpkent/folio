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
async function pointAt(page: Page, pdfX: number, pdfY: number) {
  const box = (await page.locator('.folio-page').first().boundingBox())!;
  const scale = box.width / ADDRESSES_PAGE.width;
  return {
    x: box.x + pdfX * scale,
    y: box.y + (ADDRESSES_PAGE.height - pdfY) * scale,
  };
}

async function rightClickAt(page: Page, pdfX: number, pdfY: number) {
  const { x, y } = await pointAt(page, pdfX, pdfY);
  await page.mouse.click(x, y, { button: 'right' });
  await expect(page.getByRole('menu', { name: 'Document actions' })).toBeVisible();
}

async function hoverAt(page: Page, pdfX: number, pdfY: number) {
  const { x, y } = await pointAt(page, pdfX, pdfY);
  await page.mouse.move(x, y);
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

  test('shows the whole declared target, not a prefix cut off before the deceptive part', async ({
    page,
  }) => {
    const [x0, y0, x1, y1] = ADDRESSES.link.rect;
    await rightClickAt(page, (x0 + x1) / 2, (y0 + y1) / 2);

    const detail = page.locator('.folio-context-menu__detail');
    await expect(detail).toContainText(ADDRESSES.link.target);

    // A clipped line overflows its own box (scrollWidth grows past
    // clientWidth); wrapped text does not. The target is long enough that a
    // truncated line would have cut off exactly the part that reveals where
    // it really points.
    expect(await detail.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  });

  test('marks an address under the pointer, before any click', async ({ page }) => {
    const hint = page.locator('.folio-address-hint');
    await expect(hint).toHaveCount(0);

    await hoverAt(page, ADDRESSES.email.x + 30, ADDRESSES.email.y + 5);

    // The whole point of the affordance: you can see the address is copyable
    // without right-clicking to find out.
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(ADDRESSES.email.text);
  });

  test('shows a link annotation target on hover, not its printed words', async ({ page }) => {
    const [x0, y0, x1, y1] = ADDRESSES.link.rect;
    await hoverAt(page, (x0 + x1) / 2, (y0 + y1) / 2);

    await expect(page.locator('.folio-address-hint')).toContainText(ADDRESSES.link.target);
  });

  test('the hint survives the pointer moving onto it', async ({ page }) => {
    await hoverAt(page, ADDRESSES.email.x + 30, ADDRESSES.email.y + 5);
    const hint = page.locator('.folio-address-hint');
    await expect(hint).toBeVisible();

    // WCAG 2.2 SC 1.4.13 asks for hoverable as well as dismissible: the label
    // hangs below the address, so reaching it must not take it away.
    const label = (await hint.locator('.folio-address-hint__label').boundingBox())!;
    await page.mouse.move(label.x + label.width / 2, label.y + label.height / 2);

    await expect(hint).toBeVisible();
  });

  test('the hint survives the pointer moving onto a label that overhangs the page edge', async ({
    page,
  }) => {
    await hoverAt(page, ADDRESSES.edge.x + 2, ADDRESSES.edge.y + 5);
    const hint = page.locator('.folio-address-hint');
    await expect(hint).toBeVisible();

    // Close to the page's right edge, the label hangs past the page box into
    // .folio-pages: closest('.folio-page') is null there, which used to clear
    // the hint at exactly the boundary WCAG 2.2 SC 1.4.13 exists to cover.
    const label = (await hint.locator('.folio-address-hint__label').boundingBox())!;
    await page.mouse.move(label.x + label.width - 2, label.y + label.height / 2);

    await expect(hint).toBeVisible();
  });

  test('Escape dismisses the hint without moving the pointer', async ({ page }) => {
    await hoverAt(page, ADDRESSES.email.x + 30, ADDRESSES.email.y + 5);
    await expect(page.locator('.folio-address-hint')).toBeVisible();

    // WCAG 2.2 SC 1.4.13: content shown on hover has to be dismissible.
    await page.keyboard.press('Escape');
    await expect(page.locator('.folio-address-hint')).toHaveCount(0);
  });

  test('finds nothing hovering prose that only shares a line with an address', async ({
    page,
  }) => {
    // Every other fixture address is drawn on its own, so it is also its own
    // PDF.js text item -- the one shape the hit test cannot get wrong. This one
    // shares a line (and so a text item) with an address that sits later in
    // it, which is the shape that let the hit test resolve to any address
    // anywhere on the item's line rather than the one under the pointer.
    await hoverAt(page, ADDRESSES.prose.x + 5, ADDRESSES.prose.y + 5);
    await expect(page.locator('.folio-address-hint')).toHaveCount(0);
  });

  test('shows no hint over blank space', async ({ page }) => {
    await hoverAt(page, ADDRESSES.email.x + 30, ADDRESSES.email.y + 5);
    await expect(page.locator('.folio-address-hint')).toBeVisible();

    await hoverAt(page, 350, 540);
    await expect(page.locator('.folio-address-hint')).toHaveCount(0);
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
