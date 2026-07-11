import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');

async function openFixture(page: Page) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('.folio-empty').getByRole('button', { name: /open document/i }).click(),
  ]);
  await chooser.setFiles(FORM_PDF);
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

test('fills a form field and digitally signs the document', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  // Fill the AcroForm text field rendered in the annotation layer.
  const field = page.locator('.annotationLayer input').first();
  await field.fill('Ada Lovelace');
  await expect(field).toHaveValue('Ada Lovelace');

  // Open the signing dialog and create a self-signed identity.
  await page.getByRole('button', { name: 'Digitally sign' }).click();
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
