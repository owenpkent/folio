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

// Narrow-viewport ("mobile") mode, breakpoints in src/theme/breakpoints.ts:
// at ≤640px the sidebar becomes an overlay drawer and the toolbar folds its
// pinned tail + secondary view tools into the More menu; ≤480px also folds
// zoom in/out. A phone viewport sits under both tiers.
test.use({ viewport: { width: 390, height: 844 } });

test('starts with the drawer closed and keeps every control reachable', async ({ page }) => {
  await page.goto('/');

  // The sidebar defaults closed where it would overlay the document.
  await expect(page.locator('.folio-sidebar')).toHaveCount(0);

  // Nothing is clipped off the bar.
  const toolbar = page.locator('.folio-toolbar');
  const clipped = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(clipped, 'toolbar content overflows its own width').toBeLessThanOrEqual(1);

  // Everything folded out of the bar reappears in the More menu: the pinned
  // tail (About, theme), the narrow folds (fit modes), the compact folds (zoom).
  await page.getByRole('button', { name: 'More tools' }).click();
  const menu = page.getByRole('menu', { name: 'More tools' });
  await expect(menu.getByRole('menuitem', { name: 'About Folio' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Toggle light / dark' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Fit width' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Zoom in' })).toBeVisible();
});

test('the sidebar opens as an overlay drawer and the backdrop dismisses it', async ({ page }) => {
  await page.goto('/');
  const mainBefore = await page.locator('.folio-main').boundingBox();

  await page.getByRole('button', { name: /toggle sidebar/i }).click();
  const sidebar = page.locator('.folio-sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveCSS('position', 'absolute');

  // Overlay, not flow: the viewer keeps its full width behind the drawer.
  const mainAfter = await page.locator('.folio-main').boundingBox();
  expect(mainAfter!.width, 'drawer squeezed the viewer instead of overlaying it').toBe(
    mainBefore!.width,
  );

  // Tap the dimmed area beside the drawer to dismiss it.
  await page.locator('.folio-sidebar-backdrop').click({ position: { x: 370, y: 300 } });
  await expect(page.locator('.folio-sidebar')).toHaveCount(0);
});

test('Escape dismisses the drawer, and only then closes find', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  // Open find, then the drawer on top of it (z-index 60 vs the search bar).
  await page.keyboard.press('Control+f');
  await expect(page.locator('.folio-search')).toBeVisible();
  await page.getByRole('button', { name: /toggle sidebar/i }).click();
  await expect(page.locator('.folio-sidebar')).toBeVisible();

  // First Escape peels the topmost layer only: drawer closes, find survives.
  await page.keyboard.press('Escape');
  await expect(page.locator('.folio-sidebar')).toHaveCount(0);
  await expect(page.locator('.folio-search')).toBeVisible();

  // Second Escape reaches the next layer down.
  await page.keyboard.press('Escape');
  await expect(page.locator('.folio-search')).toHaveCount(0);
});

test('picking a thumbnail navigates and closes the drawer', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  await page.getByRole('button', { name: /toggle sidebar/i }).click();
  await expect(page.locator('.folio-sidebar')).toBeVisible();

  await page.locator('.folio-thumb').first().click();
  await expect(page.locator('.folio-sidebar')).toHaveCount(0);
});

// The menu bar replaces its seven-menu desktop row with a single hamburger at
// this width; every command still needs to be reachable, including the ones
// that only ever lived in the menu bar (never on the narrow toolbar at all).
test('the menu bar collapses into a hamburger that reaches every command', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  const menuButton = page.getByRole('button', { name: 'Menu' });
  await expect(menuButton).toBeVisible();
  await menuButton.click();

  const menu = page.getByRole('menu', { name: 'Menu' });
  await expect(menu.getByRole('menuitem', { name: 'Save a copy' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Digitally sign' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
