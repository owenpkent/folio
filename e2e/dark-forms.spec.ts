import { resolve } from 'node:path';

import { expect, test, type Locator } from '@playwright/test';

const CHOICES_PDF = resolve('e2e/fixtures/choices.pdf');

/** Background and text color together: what makes an option look selected. */
const look = (option: Locator) =>
  option.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.backgroundColor} / ${style.color}`;
  });

for (const scheme of ['night', 'amber'] as const) {
  test(`dark ${scheme}: list boxes keep their selection visible after focus moves on`, async ({
    page,
  }) => {
    await page.addInitScript((s) => {
      localStorage.setItem('folio.theme', 'dark');
      localStorage.setItem('folio.darkScheme', s);
    }, scheme);
    await page.goto('/');
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page
        .locator('.folio-empty')
        .getByRole('button', { name: /open document/i })
        .click(),
    ]);
    await chooser.setFiles(CHOICES_PDF);

    // PDF.js renders list boxes as <select size>; the multi-select one also
    // carries `multiple`. Dark mode's option colors are for dropdown popups
    // only, and painting them here hid the browser's unfocused highlight.
    const single = page.locator('.folio-forms-layer select[size]:not([multiple])');
    const multi = page.locator('.folio-forms-layer select[size][multiple]');
    await expect(single).toBeVisible();
    await expect(multi).toBeVisible();

    await single.selectOption('Second');
    await multi.selectOption(['First', 'Third']);
    await page.locator('.folio-forms-layer input').first().focus();

    const singleOptions = single.locator('option');
    expect(await look(singleOptions.nth(1))).not.toBe(await look(singleOptions.nth(0)));

    const multiOptions = multi.locator('option');
    const unselected = await look(multiOptions.nth(1));
    expect(await look(multiOptions.nth(0))).not.toBe(unselected);
    expect(await look(multiOptions.nth(2))).not.toBe(unselected);
  });
}
