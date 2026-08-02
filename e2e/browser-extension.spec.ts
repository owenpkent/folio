import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * The viewer half of the browser extension.
 *
 * The extension redirects PDF navigations to this build with the document's URL
 * in `#file=`. Nothing here loads the extension itself: what is under test is
 * the contract it depends on, which is that the viewer fetches and renders
 * whatever that fragment names, and refuses what it should not fetch.
 */

const PDF = readFileSync(resolve('e2e/fixtures/form.pdf'));

/** Stand-in origin. Playwright intercepts before the network, so it never resolves. */
const ORIGIN = 'https://pdf.example';

/** Serve the fixture for anything on ORIGIN, recording what was actually asked for. */
async function serveFixture(page: Page): Promise<string[]> {
  const requested: string[] = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    requested.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: PDF });
  });
  return requested;
}

const pageCanvas = (page: Page) => page.locator('.folio-page-canvas').first();
const emptyState = (page: Page) => page.locator('.folio-empty');

/**
 * Load the viewer with `#file=<url>`, the way the extension's redirect does.
 *
 * The reload is not superstition. A `goto` whose only difference from the
 * current URL is the fragment is a same-document navigation: the app never
 * remounts, so it never reads the fragment, and the test silently asserts
 * against the previous document.
 */
async function openWithFragment(page: Page, url: string) {
  await page.goto(`/#file=${url}`);
  await page.reload();
}

test('renders a PDF named by the #file= fragment', async ({ page }) => {
  await serveFixture(page);
  await openWithFragment(page, `${ORIGIN}/doc.pdf`);
  await expect(pageCanvas(page)).toBeVisible();
});

test('keeps a query string intact instead of truncating at the first &', async ({ page }) => {
  // The fragment carries the URL un-encoded, so reading it as a query string
  // would end the URL at `&fmt=pdf` and fetch the wrong document. This is the
  // regression that motivated reading it verbatim.
  const requested = await serveFixture(page);
  const url = `${ORIGIN}/download?doc=42&fmt=pdf`;

  await openWithFragment(page, url);
  await expect(pageCanvas(page)).toBeVisible();

  expect(requested).toContain(url);
});

test('refuses schemes it will not fetch, leaving the empty state', async ({ page }) => {
  // Any site can navigate to the viewer and choose this fragment, so it is
  // untrusted input, not a private channel from the extension.
  const requested = await serveFixture(page);

  for (const hostile of ['javascript:alert(1)', 'data:application/pdf;base64,AA==']) {
    await openWithFragment(page, hostile);
    await expect(emptyState(page)).toBeVisible();
  }

  expect(requested).toEqual([]);
});

test('offers Download original only for a document opened from a URL', async ({ page }) => {
  await serveFixture(page);

  // Opened normally: nothing came from a URL, so the entry is absent rather
  // than present-but-disabled.
  await page.goto('/');
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await expect(
    page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'Download original' }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');

  await openWithFragment(page, `${ORIGIN}/doc.pdf`);
  await expect(pageCanvas(page)).toBeVisible();

  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('menu', { name: 'File' })
      .getByRole('menuitem', { name: 'Download original' })
      .click(),
  ]);
  expect(download.suggestedFilename()).toBe('doc.pdf');
});
