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
  const dropdown = page.getByRole('menu', { name: menu });
  await dropdown
    .getByRole('menuitem', { name: item })
    .or(dropdown.getByRole('menuitemcheckbox', { name: item }))
    .click();
}

/** left/top/width/height of an overlay, read from the inline style it positions with. */
async function boxOf(locator: ReturnType<Page['locator']>) {
  return locator.evaluate((el) => ({
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
  }));
}

/**
 * Place a text box near the top of the page. Kept high deliberately: at the
 * default zoom the bottom of this page sits below the window, where a click
 * would miss entirely.
 */
async function placeTextBox(page: Page) {
  await runMenuItem(page, 'Edit', 'Add text box');
  const pageBox = (await page.locator('.folio-page').first().boundingBox())!;
  await page.mouse.click(pageBox.x + pageBox.width * 0.3, pageBox.y + pageBox.height * 0.1);
  const box = page.locator('.folio-edit--text');
  await expect(box).toHaveCount(1);
  return box;
}

// Every overlay Folio lets you drag can now be moved and resized from the
// keyboard (src/a11y/useNudgeKeys.ts). Before this, dragging and the corner
// handle were the only way, which is a WCAG 2.1.1 failure on five features.
test('a placed text box is moved with the arrow keys, without ever being dragged', async ({
  page,
}) => {
  await openFixture(page);
  const box = await placeTextBox(page);

  // A fresh box has focus inside its editable, so Escape then Tab is not the
  // path: click the box itself to focus the wrapper that owns the nudge keys.
  await page.keyboard.press('Escape');
  await box.focus();
  await expect(box).toBeFocused();

  const before = await boxOf(box);
  await page.keyboard.press('ArrowRight');
  const afterOne = await boxOf(box);
  expect(afterOne.left).toBeGreaterThan(before.left);

  // Shift makes the step ten times as large, so it must move markedly further
  // than a bare press did.
  const oneStep = afterOne.left - before.left;
  await page.keyboard.press('Shift+ArrowRight');
  const afterShift = await boxOf(box);
  expect(afterShift.left - afterOne.left).toBeGreaterThan(oneStep * 5);

  // Down moves it down the page, and nothing about the size changed.
  await page.keyboard.press('ArrowDown');
  const afterDown = await boxOf(box);
  expect(afterDown.top).toBeGreaterThan(afterShift.top);
  expect(afterDown.width).toBeCloseTo(before.width, 5);
});

test('plus and minus resize a placed text box, and Delete removes it', async ({ page }) => {
  await openFixture(page);
  const box = await placeTextBox(page);
  await page.keyboard.press('Escape');
  await box.focus();

  const before = await boxOf(box);
  await page.keyboard.press('Shift+Equal'); // the '+' key
  const grown = await boxOf(box);
  expect(grown.width).toBeGreaterThan(before.width);

  await page.keyboard.press('Minus');
  const shrunk = await boxOf(box);
  expect(shrunk.width).toBeLessThan(grown.width);

  await page.keyboard.press('Delete');
  await expect(page.locator('.folio-edit--text')).toHaveCount(0);
});

// The single most important thing not to break: a text box holds a
// contentEditable, and arrows there have to move the caret.
test('arrow keys inside a text box move the caret, not the box', async ({ page }) => {
  await openFixture(page);
  const box = await placeTextBox(page);

  // The fresh box is already focused for typing.
  await page.keyboard.type('Hello');
  await expect(page.locator('.folio-edit__text')).toHaveText('Hello');

  const before = await boxOf(box);
  // Caret is at the end after typing; walk it back two characters and type, so
  // the assertion below can only pass if the arrows reached the caret.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('X');

  await expect(page.locator('.folio-edit__text')).toHaveText('HelXlo');
  const after = await boxOf(box);
  expect(after.left).toBeCloseTo(before.left, 5);
  expect(after.top).toBeCloseTo(before.top, 5);
});

test('a placed signature is moved and resized from the keyboard, aspect locked', async ({
  page,
}) => {
  await openFixture(page);

  await runMenuItem(page, 'Sign', 'Add signature');
  const dialog = page.getByRole('dialog', { name: /add signature/i });
  await dialog.getByRole('tab', { name: 'Type' }).click();
  await dialog.getByLabel('Signature text').fill('Ada Lovelace');
  await dialog.getByRole('button', { name: /place on page/i }).click();

  const pageBox = (await page.locator('.folio-page').first().boundingBox())!;
  await page.mouse.click(pageBox.x + pageBox.width * 0.5, pageBox.y + pageBox.height * 0.15);

  const sig = page.locator('.folio-signature');
  await expect(sig).toHaveCount(1);

  // A signature has no selected state of its own, so focus is the selection.
  await sig.focus();
  await expect(sig).toBeFocused();

  const before = await boxOf(sig);
  await page.keyboard.press('ArrowDown');
  expect((await boxOf(sig)).top).toBeGreaterThan(before.top);

  // Aspect-locked, so growing changes both axes together rather than
  // stretching: a signature squashed on one axis reads as a forgery.
  const beforeGrow = await boxOf(sig);
  await page.keyboard.press('Shift+Equal');
  const grown = await boxOf(sig);
  expect(grown.width).toBeGreaterThan(beforeGrow.width);
  expect(grown.height).toBeGreaterThan(beforeGrow.height);

  await page.keyboard.press('Delete');
  await expect(page.locator('.folio-signature')).toHaveCount(0);
});

test('a nudge key does not also page the document', async ({ page }) => {
  await openFixture(page);
  const box = await placeTextBox(page);
  await page.keyboard.press('Escape');
  await box.focus();

  await expect(box).toBeFocused();
  const viewer = page.locator('.folio-viewer');
  const scrollBefore = await viewer.evaluate((el) => el.scrollTop);
  const topBefore = (await boxOf(box)).top;

  // ArrowDown is bound to scrolling the document. With an overlay focused it
  // has to belong to the overlay alone, or moving an item would sail the page
  // out from under it.
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');

  // Both halves matter: the box moved (so the key was handled) and the document
  // did not scroll (so it was handled *only* here). Asserting the scroll alone
  // would pass just as well if nothing had happened at all.
  expect((await boxOf(box)).top).toBeGreaterThan(topBefore);
  expect(await viewer.evaluate((el) => el.scrollTop)).toBe(scrollBefore);
});
