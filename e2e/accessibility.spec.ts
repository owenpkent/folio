import { expect, test } from '@playwright/test';

/**
 * Platform-settings behavior, which Section 508 503.2 requires and WCAG does
 * not: the UI must honor the user's own color, contrast and font-size choices.
 * See docs/508-conformance.md.
 *
 * Forced colors are emulated per-test with `page.emulateMedia` rather than the
 * `forcedColors` fixture, which does not take effect in this setup — the media
 * query simply never matches, and every assertion below would pass vacuously
 * against unstyled defaults.
 */

test.describe('platform font size (503.2)', () => {
  test('UI text scales with the user’s root font size', async ({ page }) => {
    await page.goto('/');
    // Sizes are in rem, so the browser/OS "default font size" preference (which
    // sets the root size) scales the whole UI. A px-based UI would ignore it.
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize))
      .toBe('14px');

    await page.evaluate(() => {
      document.documentElement.style.fontSize = '20px';
    });
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize))
      .toBe('17.5px');
  });
});

test.describe('forced colors / Windows High Contrast (503.2)', () => {
  test('design tokens resolve to system colors', async ({ page }) => {
    await page.goto('/');
    await page.emulateMedia({ forcedColors: 'active' });

    const tokens = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      return {
        focus: s.getPropertyValue('--folio-focus').trim(),
        text: s.getPropertyValue('--folio-text').trim(),
        shadow: s.getPropertyValue('--folio-shadow').trim(),
      };
    });
    expect(tokens.focus).toBe('Highlight');
    expect(tokens.text).toBe('CanvasText');
    // Shadows are not forced by the browser, so an author-colored one would
    // survive as a smudge in the user's palette.
    expect(tokens.shadow).toBe('none');
  });

  test('a toggled button stays visually distinct from an untoggled one', async ({ page }) => {
    await page.goto('/');
    await page.emulateMedia({ forcedColors: 'active' });

    // Toggle state is a background-color change, and forced colors flatten
    // exactly that, so without an explicit outline the two look identical.
    const active = page.getByRole('button', { name: /toggle sidebar/i });
    await expect(active).toHaveAttribute('aria-pressed', 'true');
    expect(await active.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

    const inactive = page.getByRole('button', { name: /hand tool/i });
    await expect(inactive).toHaveAttribute('aria-pressed', 'false');
    expect(await inactive.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
  });

  test('the rendered page opts out of recoloring', async ({ page }) => {
    await page.goto('/');
    await page.emulateMedia({ forcedColors: 'active' });

    // A PDF page is document content: it must render as its author wrote it,
    // not remapped to the system palette.
    const adjust = await page.evaluate(() => {
      const el = document.createElement('canvas');
      el.className = 'folio-page-canvas';
      document.body.appendChild(el);
      const value = getComputedStyle(el).forcedColorAdjust;
      el.remove();
      return value;
    });
    expect(adjust).toBe('none');
  });
});
