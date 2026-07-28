import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');

async function openFixture(page: Page) {
  await page.goto('/');
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

async function runMenuItem(page: Page, menu: string, item: string) {
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  await page.getByRole('menu', { name: menu }).getByRole('menuitem', { name: item }).click();
}

/** Click a page at the given fractions of its own box, and report where. */
async function clickPageAt(page: Page, fx: number, fy: number) {
  const pageEl = page.locator('.folio-page').first();
  const box = (await pageEl.boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  return box;
}

// Placement used to drop every new item in the middle of the page, leaving the
// user to drag it where they actually wanted it.
test('a text box lands where the user clicks, not in the middle of the page', async ({ page }) => {
  await openFixture(page);
  await runMenuItem(page, 'Edit', 'Add text box');

  // The mode is visible, and nothing is placed until the page is clicked.
  await expect(page.locator('.folio-placement-hint')).toBeVisible();
  await expect(page.locator('.folio-edit--text')).toHaveCount(0);

  await clickPageAt(page, 0.2, 0.25);

  const box = page.locator('.folio-edit--text');
  await expect(box).toHaveCount(1);
  await expect(page.locator('.folio-placement-hint')).toHaveCount(0);

  // Top-left anchored at the click, so typing starts where the user clicked.
  const rect = await box.evaluate((el) => ({ left: el.style.left, top: el.style.top }));
  expect(parseFloat(rect.left)).toBeCloseTo(20, 0);
  expect(parseFloat(rect.top)).toBeCloseTo(25, 0);

  // The fresh box has focus, so typing goes straight into it.
  await page.keyboard.type('Hello');
  await expect(page.locator('.folio-edit__text')).toHaveText('Hello');
});

test('Escape cancels an armed placement without placing anything', async ({ page }) => {
  await openFixture(page);
  await runMenuItem(page, 'Edit', 'Add text box');
  await expect(page.locator('.folio-placement-hint')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('.folio-placement-hint')).toHaveCount(0);

  await clickPageAt(page, 0.5, 0.5);
  await expect(page.locator('.folio-edit--text')).toHaveCount(0);
});

// Clicking a spot is pointer-only, so the banner has to carry the keyboard
// path (WCAG 2.1.1) — and it must take focus, or reaching it would mean tabbing
// through the whole window first.
test('a text box can be placed without a pointer', async ({ page }) => {
  await openFixture(page);
  await runMenuItem(page, 'Edit', 'Add text box');

  const placeInMiddle = page.getByRole('button', { name: /place in the middle/i });
  await expect(placeInMiddle).toBeFocused();
  await page.keyboard.press('Enter');

  const box = page.locator('.folio-edit--text');
  await expect(box).toHaveCount(1);
  await expect(page.locator('.folio-placement-hint')).toHaveCount(0);

  // Centered on the page, not hung off its middle, and ready to type into.
  const rect = await box.evaluate((el) => ({
    left: parseFloat(el.style.left),
    width: parseFloat(el.style.width),
  }));
  expect(rect.left + rect.width / 2).toBeCloseTo(50, 0);
  await page.keyboard.type('Typed, never clicked');
  await expect(page.locator('.folio-edit__text')).toHaveText('Typed, never clicked');
});

// A click that cannot place anything should not leave the mode silently armed.
test('a click off the page cancels an armed placement', async ({ page }) => {
  await openFixture(page);
  await runMenuItem(page, 'Edit', 'Add text box');
  await expect(page.locator('.folio-placement-hint')).toBeVisible();

  // The margin beside the page, inside the viewer but not on a page.
  const pageBox = (await page.locator('.folio-page').first().boundingBox())!;
  await page.mouse.click(pageBox.x / 2, pageBox.y + 40);
  await expect(page.locator('.folio-placement-hint')).toHaveCount(0);

  // Re-armed, a click on the toolbar disarms it too.
  await runMenuItem(page, 'Edit', 'Add text box');
  await expect(page.locator('.folio-placement-hint')).toBeVisible();
  await page.getByRole('button', { name: /about folio/i }).click();
  await expect(page.locator('.folio-placement-hint')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await clickPageAt(page, 0.3, 0.3);
  await expect(page.locator('.folio-edit--text')).toHaveCount(0);
});

// The box used to be movable only by a 22x10px grip above its top-left corner.
test('a text box is dragged from anywhere on it, and a plain click still edits', async ({
  page,
}) => {
  await openFixture(page);
  await runMenuItem(page, 'Edit', 'Add text box');
  const pageBox = await clickPageAt(page, 0.2, 0.25);

  const box = page.locator('.folio-edit--text');
  await page.keyboard.type('Drag me');

  // Press in the middle of the box (over the text, nowhere near a handle) and
  // drag it a quarter of the page to the right.
  const before = (await box.boundingBox())!;
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + pageBox.width * 0.25, before.y + 4, {
    steps: 8,
  });
  await page.mouse.up();

  const after = (await box.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(pageBox.width * 0.2);
  // The text survived the drag rather than being replaced or cleared.
  await expect(page.locator('.folio-edit__text')).toHaveText('Drag me');

  // A press that does not travel is still a click: the caret goes back in and
  // typing appends instead of moving the box.
  const settled = (await box.boundingBox())!;
  await page.mouse.click(settled.x + settled.width / 2, settled.y + settled.height / 2);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await expect(page.locator('.folio-edit__text')).toHaveText('Drag me!');
  expect(Math.abs((await box.boundingBox())!.x - settled.x)).toBeLessThan(2);
});

test('a typed signature is placed at the click and its name is offered next time', async ({
  page,
}) => {
  await openFixture(page);
  await runMenuItem(page, 'Sign', 'Add signature');

  const dialog = page.getByRole('dialog', { name: /add signature/i });
  await dialog.getByRole('tab', { name: 'Type' }).click();
  await dialog.getByLabel('Signature text').fill('Ada Lovelace');
  await dialog.getByRole('button', { name: /place on page/i }).click();

  // The dialog gets out of the way and the click decides the position.
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.folio-placement-hint')).toBeVisible();
  await expect(page.locator('.folio-signature')).toHaveCount(0);

  // Kept in the upper half of the page: at the default zoom the bottom of a
  // Letter page sits below the window, where a click would miss it entirely.
  await clickPageAt(page, 0.65, 0.4);

  const sig = page.locator('.folio-signature');
  await expect(sig).toHaveCount(1);
  // Centered on the click: left edge sits half a width before it.
  const style = await sig.evaluate((el) => ({ left: el.style.left, width: el.style.width }));
  expect(parseFloat(style.left) + parseFloat(style.width) / 2).toBeCloseTo(65, 0);

  // Reopening offers the name back, prefilled, so it need not be retyped.
  await runMenuItem(page, 'Sign', 'Add signature');
  const reopened = page.getByRole('dialog', { name: /add signature/i });
  await reopened.getByRole('tab', { name: 'Type' }).click();
  await expect(reopened.getByLabel('Signature text')).toHaveValue('Ada Lovelace');
  await expect(reopened.getByRole('button', { name: 'Ada Lovelace' }).first()).toBeVisible();
});
