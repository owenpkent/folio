import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// A four-page document whose pages each say their original position, so a
// reorder can be read straight off the text layer rather than inferred.
const PAGES_PDF = resolve('e2e/fixtures/pages.pdf');

async function openFixture(page: Page) {
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('.folio-empty')
      .getByRole('button', { name: /open document/i })
      .click(),
  ]);
  await chooser.setFiles(PAGES_PDF);
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

const pageCount = (page: Page) => page.locator('.folio-pagebox__total');
const selectPage = (page: Page, n: number) =>
  page.getByRole('checkbox', { name: `Select page ${n}` }).click({ force: true });

/** The word printed on the document's first page, read from its text layer. */
async function firstPageWord(page: Page): Promise<string> {
  const layer = page.locator('.folio-text-layer').first();
  await expect(layer).not.toBeEmpty();
  return ((await layer.innerText()) ?? '').trim();
}

test.describe('page operations', () => {
  test('deletes a selected page and puts it back with undo', async ({ page }) => {
    await openFixture(page);
    await expect(pageCount(page)).toHaveText('/ 4');

    await selectPage(page, 2);
    await runMenuItem(page, 'Pages', 'Delete pages');
    await expect(pageCount(page)).toHaveText('/ 3');

    await page.keyboard.press('Control+z');
    await expect(pageCount(page)).toHaveText('/ 4');
  });

  test('refuses to delete every page', async ({ page }) => {
    await openFixture(page);

    for (const n of [1, 2, 3, 4]) await selectPage(page, n);
    await expect(page.getByText('4 pages selected')).toBeVisible();

    // The action bar's Delete is the one surface that can offer this, so it is
    // the one that has to say no.
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    await expect(pageCount(page)).toHaveText('/ 4');
  });

  test('reorders by keyboard and announces it', async ({ page }) => {
    await openFixture(page);
    expect(await firstPageWord(page)).toBe('ONE');

    await selectPage(page, 1);
    await page.keyboard.press('Alt+ArrowDown');

    // The announcer's own region, not the toolbar's polite zoom readout.
    await expect(page.locator('.folio-sr-only[aria-live="polite"]')).toContainText(
      'Moved 1 page down',
    );
    await expect
      .poll(async () => firstPageWord(page), { message: 'page 2 should now be first' })
      .toBe('TWO');
  });

  test('reorders by dragging a thumbnail past the one below it', async ({ page }) => {
    await openFixture(page);
    expect(await firstPageWord(page)).toBe('ONE');

    const card = (n: number) => page.locator(`.folio-page-card[data-page-number="${n}"]`);
    const from = (await card(1).boundingBox())!;
    const to = (await card(2).boundingBox())!;

    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Clear the drag threshold first, then settle below page 2's middle, which
    // is the gap the drop lands in.
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 20, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height * 0.9, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => firstPageWord(page), { message: 'the drag should have moved page 1 down' })
      .toBe('TWO');
  });

  test('rotates a selected page', async ({ page }) => {
    await openFixture(page);
    const before = (await page.locator('.folio-page').first().boundingBox())!;

    await selectPage(page, 1);
    await runMenuItem(page, 'Pages', 'Rotate pages right');

    // A quarter turn swaps the page box's sides, which is visible in layout.
    await expect
      .poll(
        async () => {
          const after = (await page.locator('.folio-page').first().boundingBox())!;
          return after.width > after.height;
        },
        { message: 'the first page should now be landscape' },
      )
      .toBe(true);
    expect(before.height).toBeGreaterThan(before.width);
  });

  test('opens the organizer and shows every page', async ({ page }) => {
    await openFixture(page);
    await runMenuItem(page, 'Pages', 'Organize pages…');

    const dialog = page.getByRole('dialog', { name: 'Organize pages' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.folio-page-card')).toHaveCount(4);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('keeps the thumbnail checkboxes reachable by keyboard', async ({ page }) => {
    await openFixture(page);

    const check = page.getByRole('checkbox', { name: 'Select page 2' });
    await check.focus();
    await page.keyboard.press('Enter');

    await expect(check).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('1 page selected')).toBeVisible();
  });
});
