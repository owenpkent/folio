# Folio Theming

Folio's look is driven entirely by **CSS custom properties** (design tokens). There is no hard-coded color anywhere in the UI: components read tokens, and toggling the theme changes token values for the chrome and re-rasterizes the page itself. This keeps dark mode native, keeps contrast auditable, and lets plugins match the app for free.

Dark mode is unified: a single **light / dark / system** toggle (`theme.toggle`, `Ctrl/Cmd+Shift+L`, moon/sun icon) drives both the application chrome (toolbar, sidebar, dialogs — via `data-theme` on `<html>`) and the rendered PDF page together. Light shows the page as authored; dark darkens the chrome and inverts the page at once. There is no separate reading-mode setting — switching the theme is the only control, and when dark is active a second, dark-only setting called the **dark scheme** picks which colors the inverted page uses (night/green/amber, see below). The theme system lives entirely in `src/theme/`: `ThemeProvider.tsx` sets `data-theme` on `<html>`, `tokens.css` declares the tokens, and `themeStore.ts` holds `theme`, `resolvedTheme`, and `darkScheme` (all persisted to local storage).

## Design tokens

Tokens are namespaced with the `--folio-` prefix and declared on `:root` in `src/theme/tokens.css`. Component CSS references only these tokens, never literal colors. The full light-theme set:

```css
:root,
:root[data-theme='light'] {
  /* Surfaces */
  --folio-bg:            #f4f5f7;  /* app background, behind everything */
  --folio-surface:       #ffffff;  /* panels: toolbar, sidebar, cards */
  --folio-surface-2:     #eceef1;  /* recessed / selected surfaces */
  --folio-surface-hover: #e4e7eb;  /* hover fill on interactive surfaces */

  /* Text */
  --folio-text:          #1c1f24;  /* primary text */
  --folio-text-muted:    #5b626e;  /* secondary text, hints, disabled */

  /* Lines and accents */
  --folio-border:        #d9dce1;  /* dividers, input borders */
  --folio-accent:        #2f6bff;  /* primary action, active state, links */
  --folio-accent-hover:  #1f57e6;  /* accent hover state */
  --folio-accent-contrast:#ffffff; /* text/icon on an accent fill */
  --folio-focus:         #2f6bff;  /* focus ring; may match accent */

  /* Feedback */
  --folio-danger:        #d64545;

  /* Shadows and page */
  --folio-shadow:        0 6px 24px rgba(15, 18, 25, 0.12);
  --folio-page-shadow:   0 1px 3px rgba(15, 18, 25, 0.18), 0 8px 24px rgba(15, 18, 25, 0.1);
  --folio-page-bg:       #ffffff;  /* the PDF page sheet itself */

  /* Sizing and motion */
  --folio-toolbar-height:48px;
  --folio-sidebar-width: 264px;
  --folio-radius:        10px;
  --folio-radius-sm:     6px;
  --folio-space:         8px;
  --folio-transition:    150ms ease;
  --folio-font:          system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
```

Rules of thumb:

- **Surfaces stack:** `--folio-bg` (deepest) is the app background; `--folio-surface` is panels (toolbar, sidebar); `--folio-surface-2` and `--folio-surface-hover` are the recessed/selected and hover states layered on top.
- **Text pairs with surfaces:** `--folio-text` and `--folio-text-muted` are chosen to meet WCAG 2.2 AA contrast against `--folio-bg` and `--folio-surface` in every theme.
- **`--folio-focus` is separate from `--folio-accent`** even when their values match, so a theme can diverge them (for example, a higher-contrast focus ring) without touching accent styling.
- **`--folio-page-bg` and `--folio-page-shadow`** style the PDF page sheet and stay white in both themes; the page raster itself is recolored at render time when dark mode is active, not by theme tokens.

## Light vs dark values

The dark theme overrides the same token names under `[data-theme='dark']`. Component CSS does not change; only the values do. Sizing and motion tokens are not repeated (they are inherited from `:root`).

```css
:root[data-theme='dark'] {
  --folio-bg:            #17191d;
  --folio-surface:       #1f2228;
  --folio-surface-2:     #2a2e36;
  --folio-surface-hover: #333944;
  --folio-text:          #e7e9ee;
  --folio-text-muted:    #9aa2b1;
  --folio-border:        #333944;
  --folio-accent:        #6f9bff;  /* lightened so it stays legible on dark */
  --folio-accent-hover:  #8bb0ff;
  --folio-accent-contrast:#0d1016; /* dark text on the lightened accent */
  --folio-focus:         #6f9bff;
  --folio-danger:        #ff6b6b;
  --folio-shadow:        0 6px 24px rgba(0, 0, 0, 0.5);
  --folio-page-shadow:   0 1px 3px rgba(0, 0, 0, 0.5), 0 10px 30px rgba(0, 0, 0, 0.45);
  --folio-page-bg:       #ffffff;
}
```

Note that `--folio-accent` and `--folio-focus` are lightened in dark mode. A brand blue that reads well on white is too dark on a near-black surface, so the dark theme uses a tint that keeps the 3:1 non-text contrast and 4.5:1 text contrast targets. `--folio-accent-contrast` correspondingly flips to a near-black so text on an accent fill stays legible. `--folio-page-bg` deliberately stays white so an untouched page renders true to print; dark mode darkens the page itself at raster time (see below), not via this token.

## How `data-theme` and system preference work

The active UI theme is one of `light`, `dark`, or `system`, stored in `themeStore` and persisted (local storage). `ThemeProvider` resolves it and writes the result to the document element:

- **`light`** → `document.documentElement.setAttribute("data-theme", "light")`.
- **`dark`** → `data-theme="dark"`.
- **`system`** → Folio reads `window.matchMedia("(prefers-color-scheme: dark)")`, sets `data-theme` accordingly, and subscribes to the media query so a change to the OS setting flips the app live without a reload.

Because everything keys off a single `data-theme` attribute on `<html>`, there is no flash of the wrong theme and no per-component theme logic. The `theme.toggle` command (see `docs/accessibility.md`) flips between light and dark based on the currently resolved theme (it never sets the stored preference back to `system`) and announces the change through the live region.

`prefers-color-scheme` also seeds a sensible default on first run, and `prefers-reduced-motion` is honored by neutralizing `--folio-transition` (see Reduced motion below).

## Dark mode and raster-time page inversion

Dark mode affects the chrome via tokens (above) and the rendered PDF page via a canvas operation applied when the page is drawn, not a CSS filter. `PdfJsEngine.renderPage` (`src/core/pdf/PdfJsEngine.ts`) draws the page normally and then, when dark mode is active, paints a full-canvas white fill with `globalCompositeOperation = 'difference'` over the backing store. Difference-with-white is mathematically identical to `filter: invert(1)`, but because it runs on the real canvas at full backing-store resolution rather than as a browser-composited CSS filter, dark pages come out razor-sharp instead of blurred.

This replaces the previous approach, which applied a CSS `filter` (`invert(1) hue-rotate(180deg)`, plus sepia/contrast variants for other modes) to the page canvas element. Some rendering engines re-rasterize a filtered element at CSS pixel size before compositing it back at device resolution, which visibly softened text on a filtered page. Doing the inversion as a paint operation on the canvas itself, at the canvas's own backing-store resolution, avoids that resampling step entirely.

Pages re-render whenever the theme or the dark scheme (below) changes, since the inversion is baked into the raster rather than layered on top of it with CSS.

The text layer is unaffected either way: it is a transparent, positioned overlay used for selection and screen readers (see `docs/accessibility.md`), not a visible raster, so there is nothing on it to invert or tint.

Under forced colors (Windows High Contrast) the canvas still sets `forced-color-adjust: none`, so the document keeps its authored colors, and dark mode's own inversion still applies on top as the user's explicit choice — see [508-conformance.md](508-conformance.md).

## Dark reading schemes

When dark mode is active, `darkScheme` (`src/theme/themeStore.ts`, values `'night' | 'green' | 'amber'`, default `'night'`, persisted as `folio.darkScheme`) chooses the color the inverted page renders in, Acrobat-style:

- **`night`** (default) — plain white-on-black. Just the difference-invert described above, with no further tint.
- **`green`** — green text on black.
- **`amber`** — amber text on black.

The tint is applied at raster time, after the difference-invert: a `multiply` fill of an RGB color over the now-inverted canvas. `DARK_SCHEME_TINT` (`src/core/pdf/PdfJsEngine.ts`) maps `green` to `[74, 222, 128]` and `amber` to `[240, 185, 80]`; `night` has no tint (`null`). Multiplying rather than replacing the color means the now-white ink picks up the tint while black stays black, so anti-aliasing at glyph edges is preserved instead of banding. `DARK_SCHEME_LABELS` supplies the display names shown in the picker.

`darkScheme` is chosen from a toolbar dropdown, `DarkSchemeMenu` (`src/components/Toolbar/DarkSchemeMenu.tsx`, using the contrast/◐ icon), which sits next to the light/dark toggle. The setting is tied to dark mode: in light mode the page renders as authored regardless of which scheme is selected; in dark mode, the selected scheme is what you see. Changing the scheme while dark mode is active re-renders visible pages immediately, the same as toggling the theme itself.

**Thumbnails are the one place still using a CSS filter**, since they are small enough that the blur the raster approach fixes for full pages is not visible on them:

```css
[data-theme='dark'] .folio-thumb__canvas {
  filter: invert(1) hue-rotate(180deg);
}
```

## Adding a new UI theme

You do not need to touch component code to add a theme. You add a token block and register the option.

1. **Add a token block** in the theme stylesheet under a new selector, overriding every token that should differ:

   ```css
   :root[data-theme='high-contrast-dark'] {
     --folio-bg:            #000000;
     --folio-surface:       #0a0a0a;
     --folio-surface-2:     #141414;
     --folio-surface-hover: #1e1e1e;
     --folio-text:          #ffffff;
     --folio-text-muted:    #d0d0d0;
     --folio-border:        #ffffff;
     --folio-accent:        #ffd400;
     --folio-accent-contrast:#000000;
     --folio-focus:         #ffd400;
   }
   ```

2. **Register the option** in `themeStore` so the value is allowed and persisted, and add it to the theme picker in the UI. The theme toggle/cycle command will include it automatically once it is a registered value.

3. **Verify contrast by hand.** Confirm text and focus meet the AA targets with the new theme active: 4.5:1 for normal text, 3:1 for large text and non-text UI, and 3:1 for focus rings against what sits next to them. There is **no automated contrast check** — axe-core is planned but not wired up (see [testing.md](testing.md)), so a new theme's contrast is only as good as the person who checked it.

That is the whole process: no component edits, because components only ever read `--folio-*` tokens.

## How plugins consume theme tokens

Plugins (see `docs/architecture.md`, "Extension points") style their UI with the same `--folio-*` tokens instead of literal colors:

```css
.my-plugin-panel {
  background: var(--folio-surface);
  color: var(--folio-text);
  border: 1px solid var(--folio-border);
  border-radius: var(--folio-radius);
  transition: background var(--folio-transition);
}
.my-plugin-panel button {
  background: var(--folio-accent);
  color: var(--folio-accent-contrast);
}
.my-plugin-panel :focus-visible {
  outline: 2px solid var(--folio-focus);
  outline-offset: 2px;
}
```

Because tokens are declared on `:root` and cascade everywhere, plugin UI automatically follows the active theme, updates live when the user toggles theme, and honors any custom themes the user has added. Guidance for plugin authors:

- **Always use tokens for color, radius, shadow, and transition.** Never hard-code a hex value; it will break dark mode and custom themes and may fail contrast checks.
- **Use `--folio-focus` for focus rings** so your controls match the app's visible-focus requirement.
- **Do not filter your own surfaces to emulate the dark page inversion.** That inversion applies to rendered page content only; plugin chrome should track the UI theme via tokens, the same as everything else.

## Reduced motion

`prefers-reduced-motion: reduce` is honored globally by collapsing the motion token and, as a safety net, neutralizing any remaining animations, transitions, and smooth scrolling:

```css
@media (prefers-reduced-motion: reduce) {
  :root { --folio-transition: 0ms; }
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
```

Since components (and well-behaved plugins) reference `--folio-transition` rather than writing their own durations, the token override removes non-essential animation from token-driven styles; the universal rule catches anything that hard-coded a duration. State changes still occur; they just happen instantly, and meaning is carried by the live-region announcements rather than the animation.

## Related documents

- `docs/architecture.md`: where the theme layer and `themeStore` sit in the stack.
- `docs/accessibility.md`: contrast targets, focus, reduced motion, and dark-mode/dark-scheme accessibility.
