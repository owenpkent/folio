import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

const FORM_PDF = resolve('e2e/fixtures/form.pdf');
/** Same shape as form.pdf, but its fields carry values and baked appearances. */
const FILLED_FORM_PDF = resolve('e2e/fixtures/filled-form.pdf');

/** Open a top-level menu and click one of its rows. Toggle rows (Edit text,
    Edit images, the View menu's checkables) carry role="menuitemcheckbox"
    rather than "menuitem", so both are accepted. */
async function runMenuItem(page: Page, menu: string, item: string) {
  await page.getByRole('menuitem', { name: menu, exact: true }).click();
  const dropdown = page.getByRole('menu', { name: menu });
  await dropdown
    .getByRole('menuitem', { name: item })
    .or(dropdown.getByRole('menuitemcheckbox', { name: item }))
    .click();
}

async function openFixture(page: Page, file: string = FORM_PDF) {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page
      .locator('.folio-empty')
      .getByRole('button', { name: /open document/i })
      .click(),
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

test('the appearance menu switches to dark mode', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^appearance:/i }).click();
  await page.getByRole('menuitemradio', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('one button opens every viewing-mode option, mode and dark colour alike', async ({ page }) => {
  await page.goto('/');

  // The mode and the dark reading colour used to be two separate buttons.
  await expect(page.getByRole('button', { name: /^appearance:/i })).toHaveCount(1);
  await page.getByRole('button', { name: /^appearance:/i }).click();

  const menu = page.getByRole('menu', { name: 'Appearance' });
  for (const option of ['Light', 'Dark', 'Match system', 'Night', 'Green', 'Amber']) {
    await expect(menu.getByRole('menuitemradio', { name: option, exact: true })).toBeVisible();
  }

  // 'system' is only reachable now that the toggle became a menu; picking it
  // hands the choice back to the OS query rather than pinning a theme.
  await menu.getByRole('menuitemradio', { name: 'Match system', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Appearance: Match system' })).toBeVisible();
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
        page
          .locator('.folio-page-canvas')
          .first()
          .evaluate((el) => {
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

test('a real checkbox widget renders, is keyboard reachable, and toggles', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  // Real AcroForm checkbox widgets are handled entirely by PDF.js's own
  // annotation layer (renderForms), not by anything Folio adds on top; this
  // guards that nothing regresses that path. Ticking a checkbox that has no
  // real form field is a separate tool (Add check mark) covered elsewhere.
  const checkbox = page.locator('.folio-forms-layer input[type="checkbox"]');
  await expect(checkbox).toHaveCount(1);
  await expect(checkbox).not.toBeChecked();

  // Keyboard reachable: it can take focus and be toggled without a pointer.
  await checkbox.focus();
  await expect(checkbox).toBeFocused();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();

  // And toggles back off on a real pointer click.
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
});

test('a checkbox still toggles while the Edit text tool is on', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  // Edit text lives in the Edit menu now, not on the toolbar.
  await runMenuItem(page, 'Edit', 'Edit text');
  // Assert the tool is actually armed: without this, a broken toggle would
  // leave the click-catcher unmounted and the rest of the test would pass for
  // the wrong reason (the checkbox getting a normal, uncontested click). One
  // catcher mounts per page, so `.first()` avoids a strict-mode violation on
  // this two-page fixture.
  await expect(page.locator('.folio-textedit-hit').first()).toBeVisible();

  // The catcher covers the whole page above the forms layer (see
  // TextEditLayer.tsx), so a real click on the checkbox lands on the catcher
  // first, same as a user's click would. `force` skips Playwright's own
  // topmost-element check so the click still fires at the checkbox's
  // coordinates instead of timing out there; whether it actually reaches the
  // checkbox is then entirely down to Folio's own redirect.
  const checkbox = page.locator('.folio-forms-layer input[type="checkbox"]');
  await expect(checkbox).not.toBeChecked();
  await checkbox.click({ force: true });
  await expect(checkbox).toBeChecked();
});

test('a check mark is placed where you click, through the shared placement mode', async ({
  page,
}) => {
  await page.goto('/');
  await openFixture(page);

  await runMenuItem(page, 'Edit', 'Add check mark');
  // The one shared placement banner and catcher, not a tool-specific one: the
  // check-mark tool was migrated onto features/placement so all four placing
  // tools have the same visible mode, Escape handling, and keyboard path.
  await expect(page.locator('.folio-placement-hint')).toBeVisible();
  await expect(page.locator('.folio-edit--mark')).toHaveCount(0);

  const box = (await page.locator('.folio-page').first().boundingBox())!;
  // Near the top of the page for two reasons: at the default zoom the bottom of
  // this page sits below the window, where a click would miss entirely, and the
  // fixture's widgets occupy roughly 16-34% of the height, which would exercise
  // the defer-to-widget path below instead of placement.
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.1);

  const mark = page.locator('.folio-edit--mark');
  await expect(mark).toHaveCount(1);
  await expect(page.locator('.folio-placement-hint')).toHaveCount(0);
  // Centered on the click, so its middle sits at the 75% mark, not its corner.
  const style = await mark.evaluate((el) => ({ left: el.style.left, width: el.style.width }));
  expect(parseFloat(style.left) + parseFloat(style.width) / 2).toBeCloseTo(75, 0);
});

test('an armed check mark yields to a real checkbox widget instead of stamping', async ({
  page,
}) => {
  await page.goto('/');
  await openFixture(page);

  await runMenuItem(page, 'Edit', 'Add check mark');
  await expect(page.locator('.folio-placement-hint')).toBeVisible();

  // The one placing tool that defers to a real field: a mark exists only to
  // stand in for a printed box with no AcroForm field behind it, so a click on
  // an actual widget means the widget. `force` skips Playwright's topmost-element
  // check, since the placement catcher legitimately covers the page.
  const checkbox = page.locator('.folio-forms-layer input[type="checkbox"]');
  await checkbox.click({ force: true });
  await expect(checkbox).toBeChecked();
  // No mark stamped on top of the widget, and the tool stays armed so the next
  // click can still place one somewhere the widget is not.
  await expect(page.locator('.folio-edit--mark')).toHaveCount(0);
  await expect(page.locator('.folio-placement-hint')).toBeVisible();
});

test('a real radio group renders and keeps its options mutually exclusive', async ({ page }) => {
  await page.goto('/');
  await openFixture(page);

  const radios = page.locator('.folio-forms-layer input[type="radio"]');
  await expect(radios).toHaveCount(2);
  await expect(radios.first()).not.toBeChecked();
  await expect(radios.nth(1)).not.toBeChecked();

  await radios.first().click();
  await expect(radios.first()).toBeChecked();
  await expect(radios.nth(1)).not.toBeChecked();

  await radios.nth(1).click();
  await expect(radios.nth(1)).toBeChecked();
  await expect(radios.first()).not.toBeChecked();
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
