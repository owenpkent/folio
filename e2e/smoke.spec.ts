import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');
/** Same shape as form.pdf, but its fields carry values and baked appearances. */
const FILLED_FORM_PDF = resolve('e2e/fixtures/filled-form.pdf');

async function openFixture(page: Page, file: string = FORM_PDF) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.folio-empty').getByRole('button', { name: /open document/i }).click(),
  ]);
  await chooser.setFiles(file);
  await expect(page.locator('.folio-page-canvas').first()).toBeVisible();
}

test('renders the empty state on launch', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Folio' })).toBeVisible();
  await expect(
    page.locator('.folio-empty').getByRole('button', { name: /open document/i }),
  ).toBeVisible();
});

test('toggles dark mode', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /toggle light \/ dark/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('opens a PDF and renders its pages', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);
  await expect(page.locator('.folio-page')).toHaveCount(2);
  await expect(page.locator('.folio-pagebox__total')).toContainText('2');
});

test('does not paint filled field values into the page canvas', async ({ page }) => {
  await page.goto('/');
  await openFixture(page, FILLED_FORM_PDF);

  // The annotation layer draws each field as a real <input>. If the canvas also
  // rasterises the widget's appearance stream, both copies of the value show at
  // once as doubled, unreadable text. The fixture's page has no content besides
  // its three fields, so any ink on the canvas is a widget that should not be
  // there. Guards the annotationMode passed to page.render: only ENABLE_FORMS
  // suppresses the widget paint, and a regression to ENABLE (or to
  // ENABLE_STORAGE, which sets a different intent flag) puts the ink back.
  await expect(page.locator('.folio-forms-layer input')).toHaveCount(3);
  await expect
    .poll(
      () =>
        page.locator('.folio-page-canvas').first().evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const ctx = canvas.getContext('2d')!;
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let dark = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark++;
          }
          return dark;
        }),
      { message: 'dark pixels on the page canvas' },
    )
    .toBe(0);

  const values = await page
    .locator('.folio-forms-layer input')
    .evaluateAll((els) => (els as HTMLInputElement[]).map((e) => e.value));
  expect(values).toContain('Jonathan Q. Fillingsworth');
});

test('form fields expose the label the PDF gave them', async ({ page }) => {
  await page.goto('/');
  await openFixture(page, FILLED_FORM_PDF);

  // getByRole(..., { name }) runs the real accessible-name computation, which is
  // the point: PDF.js puts /TU on the wrapping <section> as a title, and a title
  // on an ancestor does not name the input. Asserting on the attribute alone
  // would pass while a screen reader still announced an unlabeled edit box.
  await expect(page.getByRole('textbox', { name: 'Full legal name' })).toHaveValue(
    'Jonathan Q. Fillingsworth',
  );
  await expect(page.getByRole('textbox', { name: 'Street address' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'City and state' })).toBeVisible();
});

test('Page Up and Page Down scroll the document', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);
  const viewer = page.locator('.folio-viewer');
  await expect.poll(() => viewer.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  await page.keyboard.press('PageDown');
  await expect.poll(() => viewer.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  const scrolled = await viewer.evaluate((el) => el.scrollTop);
  await page.keyboard.press('PageUp');
  await expect.poll(() => viewer.evaluate((el) => el.scrollTop)).toBeLessThan(scrolled);
});

test('Page Down still scrolls once focus has left the document', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);
  const viewer = page.locator('.folio-viewer');
  await expect.poll(() => viewer.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

  // Clicking any toolbar button moves focus off the scroller, and the browser
  // will only scroll the focused element's own scrollable ancestor. This is why
  // the scroll keys are bound as commands and not left to native behavior: it
  // covers the case the focus handling alone cannot.
  await page.getByRole('button', { name: /zoom in/i }).click();
  await page.keyboard.press('PageDown');
  await expect.poll(() => viewer.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test('the find bar hands focus back to the document when it closes', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  await page.keyboard.press('Control+f');
  await expect(page.locator('.folio-search__input')).toBeFocused();
  // Ctrl+F from inside the find input closes it again.
  await page.keyboard.press('Control+f');
  await expect(page.locator('.folio-search__input')).toHaveCount(0);

  // Focus must return to the scroller, or the scroll keys land on <body>, which
  // cannot scroll (.folio-app is overflow:hidden) and silently does nothing.
  const viewer = page.locator('.folio-viewer');
  await page.keyboard.press('PageDown');
  await expect.poll(() => viewer.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test('fills a form field and digitally signs the document', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  // Fill the AcroForm text field rendered in the annotation layer.
  const field = page.locator('.annotationLayer input').first();
  await field.fill('Ada Lovelace');
  await expect(field).toHaveValue('Ada Lovelace');

  // Open the signing dialog and create a self-signed identity. Digitally sign
  // no longer lives on the toolbar; it is reached through the Sign menu.
  await page.getByRole('menuitem', { name: 'Sign' }).click();
  await page.getByRole('menuitem', { name: 'Digitally sign' }).click();
  const dialog = page.getByRole('dialog', { name: /digitally sign/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name (Common Name)').fill('Ada Lovelace');
  await dialog.getByLabel('Passphrase for the new key').fill('pw');
  await dialog.getByRole('button', { name: 'Create identity' }).click();

  // Sign and save produces a downloaded (signed) PDF in the browser build.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Sign and save' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain('signed');
});

