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

test.describe('sidebar tabs (WCAG 2.1.1 Keyboard)', () => {
  test('every panel is reachable with the arrow keys', async ({ page }) => {
    await page.goto('/');
    const tabs = page.getByRole('tab');
    const count = await tabs.count();
    expect(count).toBeGreaterThan(1);

    // A tablist uses a roving tabindex, so Tab steps over the rail entirely and
    // the arrows are the only route to the other tabs. Without a key handler
    // every unselected panel is unreachable by keyboard — the rail looks fine
    // and is simply a dead end.
    await tabs.first().focus();
    for (let i = 1; i < count; i++) {
      await page.keyboard.press('ArrowDown');
      await expect(tabs.nth(i)).toBeFocused();
      await expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true');
    }

    // And it wraps, so a user cannot get stuck at the end.
    await page.keyboard.press('ArrowDown');
    await expect(tabs.first()).toBeFocused();
  });

  test('Home and End jump to the first and last panel', async ({ page }) => {
    await page.goto('/');
    const tabs = page.getByRole('tab');
    const last = (await tabs.count()) - 1;

    await tabs.first().focus();
    await page.keyboard.press('End');
    await expect(tabs.nth(last)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tabs.first()).toBeFocused();
  });
});

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
