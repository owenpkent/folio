# Folio Theming

Folio's look is driven entirely by **CSS custom properties** (design tokens). There is no hard-coded color anywhere in the UI: components read tokens, and switching theme or reading mode just changes token values or applies a filter. This keeps dark mode native, keeps contrast auditable, and lets plugins match the app for free.

Two independent concepts:

- **UI theme** styles the application chrome (toolbar, sidebar, dialogs). Values: **light**, **dark**, **system**. Applied via `data-theme` on `<html>`.
- **Reading mode** styles the rendered PDF page itself. Values: **normal**, **night**, **sepia**, **high-contrast**. Applied as a CSS filter on the page canvas.

You can run a dark UI with a normal page, or a light UI with a night-inverted page; the two are orthogonal by design. The theme system lives in `src/theme/` (`ThemeProvider`, design tokens, reading modes) and is backed by `themeStore` in `src/state/`.

## Design tokens

Tokens are namespaced with the `--folio-` prefix and declared on `:root`. Component CSS references only these tokens, never literal colors.

```css
:root {
  /* Surfaces */
  --folio-bg:            #ffffff;  /* app background, behind everything */
  --folio-surface:       #f4f5f7;  /* panels: toolbar, sidebar, cards */
  --folio-surface-raised:#ffffff;  /* menus, popovers, dialogs */

  /* Text */
  --folio-text:          #1a1c1e;  /* primary text */
  --folio-text-muted:    #5c6066;  /* secondary text, hints, disabled */

  /* Lines and accents */
  --folio-border:        #d7dade;  /* dividers, input borders */
  --folio-accent:        #2b6cff;  /* primary action, active state, links */
  --folio-accent-text:   #ffffff;  /* text/icon on an accent fill */
  --folio-focus:         #2b6cff;  /* focus ring; may match accent */

  /* Feedback */
  --folio-danger:        #c8341f;
  --folio-warning:       #a15c00;
  --folio-success:       #1f7a3d;

  /* Selection and highlight */
  --folio-selection:     #b9d3ff;  /* text-layer selection */
  --folio-search-hit:    #ffd54a;  /* find-in-page match */
  --folio-search-active: #ff9e2c;  /* current find-in-page match */

  /* Shape and motion */
  --folio-radius:        8px;
  --folio-shadow:        0 4px 16px rgba(0, 0, 0, 0.12);
  --folio-transition:    160ms ease;
}
```

Rules of thumb:

- **Surfaces stack:** `--folio-bg` (deepest) → `--folio-surface` (panels) → `--folio-surface-raised` (things that float above panels).
- **Text pairs with surfaces:** `--folio-text` and `--folio-text-muted` are chosen to meet WCAG 2.2 AA contrast against `--folio-bg` and `--folio-surface` in every theme.
- **`--folio-focus` is separate from `--folio-accent`** even when their values match, so a theme can diverge them (for example, a higher-contrast focus ring) without touching accent styling.

## Light vs dark values

The dark theme overrides the same token names under `[data-theme="dark"]`. Component CSS does not change; only the values do.

```css
:root,
:root[data-theme="light"] {
  --folio-bg:            #ffffff;
  --folio-surface:       #f4f5f7;
  --folio-surface-raised:#ffffff;
  --folio-text:          #1a1c1e;
  --folio-text-muted:    #5c6066;
  --folio-border:        #d7dade;
  --folio-accent:        #2b6cff;
  --folio-focus:         #2b6cff;
  --folio-selection:     #b9d3ff;
}

:root[data-theme="dark"] {
  --folio-bg:            #16181c;
  --folio-surface:       #1f2228;
  --folio-surface-raised:#272b33;
  --folio-text:          #e6e8eb;
  --folio-text-muted:    #a2a8b2;
  --folio-border:        #343a43;
  --folio-accent:        #5a8bff;  /* lightened so it stays legible on dark */
  --folio-focus:         #7aa2ff;
  --folio-selection:     #2f4c86;
}
```

Note that `--folio-accent` and `--folio-focus` are lightened in dark mode. A brand blue that reads well on white is too dark on a near-black surface, so the dark theme uses a tint that keeps the 3:1 non-text contrast and 4.5:1 text contrast targets.

## How `data-theme` and system preference work

The active UI theme is one of `light`, `dark`, or `system`, stored in `themeStore` and persisted (local storage). `ThemeProvider` resolves it and writes the result to the document element:

- **`light`** → `document.documentElement.setAttribute("data-theme", "light")`.
- **`dark`** → `data-theme="dark"`.
- **`system`** → Folio reads `window.matchMedia("(prefers-color-scheme: dark)")`, sets `data-theme` accordingly, and subscribes to the media query so a change to the OS setting flips the app live without a reload.

Because everything keys off a single `data-theme` attribute on `<html>`, there is no flash of the wrong theme and no per-component theme logic. The `theme.toggle` command (see `docs/accessibility.md`) cycles the stored preference and announces the change through the live region.

`prefers-color-scheme` also seeds a sensible default on first run, and `prefers-reduced-motion` is honored by neutralizing `--folio-transition` (see Reduced motion below).

## Reading modes and canvas filters

Reading modes affect **only the rendered PDF page**, not the chrome. They are applied as CSS `filter` values on the page canvas element, driven by a `data-reading-mode` attribute (or an equivalent class) on the page container. Using filters means the page raster is untouched: nothing is re-rendered, so switching modes is instant and reversible.

```css
/* Normal: faithful colors, no filter */
[data-reading-mode="normal"] .folio-page-canvas {
  filter: none;
}

/* Night: invert while preserving hue, so photos/logos stay recognizable */
[data-reading-mode="night"] .folio-page-canvas {
  filter: invert(1) hue-rotate(180deg);
}

/* Sepia: warm the page to reduce glare */
[data-reading-mode="sepia"] .folio-page-canvas {
  filter: sepia(0.45) contrast(0.95) brightness(1.02);
}

/* High-contrast: maximize text/background separation */
[data-reading-mode="high-contrast"] .folio-page-canvas {
  filter: contrast(1.35) brightness(1.05) grayscale(0.15);
}
```

Details worth knowing:

- **`invert(1) hue-rotate(180deg)`** for night mode inverts luminance (white page → dark) but rotates hue back, so a red stamp stays reddish rather than turning cyan. It is the standard trick for readable inverted documents.
- **The text layer is not filtered.** Only the canvas raster gets the filter. The transparent text layer that sits above it (used for selection and screen readers, see `docs/accessibility.md`) keeps its normal geometry; selection color comes from `--folio-selection`.
- **Reading mode is separate from UI theme in state.** `theme.cycleReadingMode` rotates normal → night → sepia → high-contrast and announces the new mode. A user can pick, say, a light UI with a night page, which is common for people who want dark documents but a bright toolbar.
- **High-contrast reading mode** exists specifically for low-vision users and complements, rather than replaces, the dark UI theme.

## Adding a new UI theme

You do not need to touch component code to add a theme. You add a token block and register the option.

1. **Add a token block** in the theme stylesheet under a new selector, overriding every token that should differ:

   ```css
   :root[data-theme="high-contrast-dark"] {
     --folio-bg:            #000000;
     --folio-surface:       #0a0a0a;
     --folio-surface-raised:#141414;
     --folio-text:          #ffffff;
     --folio-text-muted:    #d0d0d0;
     --folio-border:        #ffffff;
     --folio-accent:        #ffd400;
     --folio-focus:         #ffd400;
     --folio-selection:     #005fcc;
   }
   ```

2. **Register the option** in `themeStore` so the value is allowed and persisted, and add it to the theme picker in the UI. The theme toggle/cycle command will include it automatically once it is a registered value.

3. **Verify contrast.** Run the accessibility checks (axe-core in the e2e suite) with the new theme active; confirm text and focus meet the AA targets. Adding a theme is a data change, so the automated a11y coverage applies to it unchanged.

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
  color: var(--folio-accent-text);
}
.my-plugin-panel :focus-visible {
  outline: 2px solid var(--folio-focus);
  outline-offset: 2px;
}
```

Because tokens are declared on `:root` and cascade everywhere, plugin UI automatically follows the active theme, updates live when the user toggles theme, and honors any custom themes the user has added. Guidance for plugin authors:

- **Always use tokens for color, radius, shadow, and transition.** Never hard-code a hex value; it will break dark mode and custom themes and may fail contrast checks.
- **Use `--folio-focus` for focus rings** so your controls match the app's visible-focus requirement.
- **Do not filter your own surfaces to emulate reading modes.** Reading modes apply to page content only; plugin chrome should track the UI theme via tokens.

## Reduced motion

`prefers-reduced-motion: reduce` is honored globally by collapsing the motion token:

```css
@media (prefers-reduced-motion: reduce) {
  :root { --folio-transition: 0ms; }
}
```

Since components (and well-behaved plugins) reference `--folio-transition` rather than writing their own durations, one override removes non-essential animation everywhere at once. State changes still occur; they just happen instantly, and meaning is carried by the live-region announcements rather than the animation.

## Related documents

- `docs/architecture.md`: where the theme layer and `themeStore` sit in the stack.
- `docs/accessibility.md`: contrast targets, focus, reduced motion, and reading-mode accessibility.
