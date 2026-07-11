# Folio Accessibility Guide

Accessibility is a first-class requirement in Folio, not a later pass. The target is **WCAG 2.2 Level AA**. This guide documents the concrete behaviors you can rely on and test against: the keyboard model, focus rules, ARIA structure, the text layer, live-region announcements, reading modes, reduced motion, zoom/reflow, and the automated plus manual testing approach.

The accessibility utilities live in `src/a11y/` (announcer, focus management, shortcuts help). Because every user action is a `Command` with an optional `keybinding` (see `docs/architecture.md`), keyboard access and menu access run the exact same code path.

## Keyboard shortcuts

All shortcuts dispatch through the command registry. On macOS, use `Cmd` where the table shows `Ctrl`. Bindings are user-visible in the in-app shortcuts help (`src/a11y` shortcuts help), which is opened with `?`.

| Action | Command id | Windows/Linux | macOS |
|---|---|---|---|
| Open document | `file.open` | `Ctrl+O` | `Cmd+O` |
| Save / export | `file.save` | `Ctrl+S` | `Cmd+S` |
| Next page | `nav.nextPage` | `Page Down` / `→` | `Page Down` / `→` |
| Previous page | `nav.prevPage` | `Page Up` / `←` | `Page Up` / `←` |
| First page | `nav.firstPage` | `Ctrl+Home` | `Cmd+Home` |
| Last page | `nav.lastPage` | `Ctrl+End` | `Cmd+End` |
| Zoom in | `view.zoomIn` | `Ctrl+=` | `Cmd+=` |
| Zoom out | `view.zoomOut` | `Ctrl+-` | `Cmd+-` |
| Reset zoom (100%) | `view.zoomReset` | `Ctrl+0` | `Cmd+0` |
| Fit width | `view.fitWidth` | `Ctrl+1` | `Cmd+1` |
| Fit page | `view.fitPage` | `Ctrl+2` | `Cmd+2` |
| Toggle sidebar | `ui.toggleSidebar` | `Ctrl+B` | `Cmd+B` |
| Find in document | `search.open` | `Ctrl+F` | `Cmd+F` |
| Find next | `search.next` | `Enter` / `F3` | `Enter` / `Cmd+G` |
| Find previous | `search.prev` | `Shift+Enter` / `Shift+F3` | `Shift+Enter` / `Cmd+Shift+G` |
| Toggle UI theme | `theme.toggle` | `Ctrl+Shift+L` | `Cmd+Shift+L` |
| Cycle reading mode | `theme.cycleReadingMode` | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Command palette | `ui.commandPalette` | `Ctrl+Shift+P` | `Cmd+Shift+P` |
| Keyboard shortcuts help | `help.shortcuts` | `?` | `?` |

Everything reachable by mouse is reachable by keyboard. If you add a feature, add its command with a `keybinding` rather than wiring a bespoke key handler.

## Focus management rules

Focus is deliberate, visible, and never lost. Rules enforced by `src/a11y` focus management:

- **Visible focus rings, always.** Focus is styled with the `--folio-focus` token and is never removed (no `outline: none` without a replacement). Rings meet the 3:1 non-text contrast requirement in every theme and reading mode.
- **Logical tab order.** DOM order matches visual order: Toolbar → Sidebar (when open) → page viewport → status bar. Tabbing never jumps unpredictably.
- **Focus trapping in overlays.** The command palette, search bar, and any modal trap focus while open. `Tab`/`Shift+Tab` cycle within the overlay; `Escape` closes it.
- **Focus restoration.** When an overlay closes, focus returns to the element that opened it (for example, closing search returns focus to the page viewport, not the top of the document).
- **No keyboard traps in content.** The page viewport is a single focus stop; you can always `Tab` past it. Within a page you navigate text with normal caret/selection keys, not by tabbing through every word.
- **Skip to content.** A visually-hidden "Skip to document" link is the first focus stop, letting keyboard and screen-reader users bypass the toolbar.

## ARIA landmarks and roles

Folio exposes a stable landmark structure so screen-reader users can navigate by region.

| Region | Element/role | ARIA |
|---|---|---|
| Top toolbar | `role="banner"` / `role="toolbar"` | `aria-label="Folio toolbar"` |
| Sidebar (outline, thumbnails, annotations) | `role="complementary"` | `aria-label="Document sidebar"`, tabs use `role="tablist"` |
| Page viewport | `role="main"` | `aria-label="Document"`, `aria-roledescription="PDF document"` |
| Each page | `role="group"` | `aria-label="Page {n} of {total}"` |
| Search bar | `role="search"` | labeled input, `aria-live` result count |
| Status bar | `role="status"` | current page and zoom |
| Announcer | `role="status"` (visually hidden) | `aria-live="polite"`, `aria-atomic="true"` |

Additional roles: the outline tree uses `role="tree"` / `role="treeitem"` with `aria-expanded`; thumbnails use `role="listbox"` / `role="option"`; toolbar toggles expose `aria-pressed`; the reading-mode control exposes its current value.

## The text layer and screen readers

Each rendered page is a `<canvas>` (the visual raster) with a **positioned text layer** overlaid on top, built from `PdfEngine.getTextContent(pageNumber)` (PDF.js text content). This is the core of Folio's accessibility.

- **Real text, not an image.** The text layer contains the document's actual glyphs positioned over the canvas. Screen readers read this text; users select and copy it; find-in-page highlights it.
- **Selection matches the visual page.** Because text spans are positioned to align with the raster, a selection drag looks correct and yields the correct copied text.
- **Reading order.** Folio uses the document's text order from PDF.js. For tagged PDFs this reflects the logical structure; for untagged PDFs it follows the content stream order.
- **The canvas is decorative to assistive tech.** The raster carries `aria-hidden` semantics so screen readers do not announce it as an image; the text layer is the accessible representation.

## Live-region announcements

State changes that are obvious visually but silent to a screen reader are announced through the polite live region in `src/a11y` (the announcer). Announcements are debounced so rapid changes (holding Page Down) do not flood the reader.

Examples of announced messages:

- Page change: `Page 5 of 24`
- Zoom change: `Zoom 150%`
- Fit change: `Fit width` / `Fit page`
- Reading mode: `Reading mode: night`
- Theme change: `Dark theme`
- Search results: `3 of 17 matches` (and `No matches` when empty)
- Document loaded: `Opened report.pdf, 24 pages`
- Sidebar: `Sidebar shown` / `Sidebar hidden`

Announcements use `aria-live="polite"` so they never interrupt the user mid-sentence. Errors that require attention (for example, a file that failed to open) use an assertive alert instead.

## Reading modes and contrast

Folio separates the **UI theme** (chrome) from the **reading mode** (the page itself). Full detail is in `docs/theming.md`; the accessibility-relevant summary:

| Reading mode | Effect on page | Use case |
|---|---|---|
| Normal | No filter | Faithful color reproduction |
| Night | Inverted, hue-preserved | Low-light reading without a blinding white page |
| Sepia | Warm tint | Reduced glare, longer sessions |
| High-contrast | Increased contrast, normalized | Low-vision users; maximizes text/background separation |

UI text and controls meet the WCAG 2.2 AA contrast minimums (4.5:1 for normal text, 3:1 for large text and non-text UI components) in both light and dark themes. Focus indicators meet 3:1 against adjacent colors. High-contrast reading mode is provided specifically for users who need more than the default separation on page content.

## Reduced motion

Folio honors `prefers-reduced-motion`. When the user requests reduced motion:

- Page transitions, sidebar slide, and zoom animations are replaced with instant state changes.
- Smooth-scroll to a search match becomes an instant jump.
- No animation is essential to understanding state; the live-region announcement carries the meaning instead.

This is implemented at the token/CSS level so it applies uniformly, including to plugin UI that uses the standard transition tokens.

## Zoom and reflow

- **Continuous zoom** from a small fit-page view up to high magnification, via `view.zoomIn`/`view.zoomOut` (steps), `view.zoomReset` (100%), and fit modes.
- **Fit width** keeps the page column at the viewport width so horizontal scrolling is not required at typical reading zoom, which supports the WCAG reflow expectation for content.
- **OS/browser text scaling** and **application zoom** stack: the surrounding UI uses relative units so it remains usable when the platform text size is increased.
- Zoom level is announced (`Zoom 150%`) and shown in the status bar so it is perceivable without relying on the visual size change alone.

## Testing approach

Accessibility is verified continuously, not audited once.

**Automated (in CI):**

- **axe-core** runs against the app in the Playwright end-to-end suite. Views (viewer, sidebar open, search open, command palette, each reading mode, light and dark) are scanned for violations, and the build fails on new violations.
- **Vitest** unit tests cover the announcer (correct messages, polite vs assertive), focus management (trap and restore), and that every command with a `keybinding` is reachable.
- Lint rules flag missing labels and `outline: none` without a focus replacement.

**Manual (per release):**

- **NVDA** on Windows and **VoiceOver** on macOS passes covering: opening a document, navigating pages, reading page text, using the outline tree, searching, and switching themes/reading modes.
- Keyboard-only pass with no mouse: confirm every action in the shortcuts table works, focus is always visible, and no overlay traps focus.
- Reduced-motion and high-contrast passes with the OS setting enabled.

## WCAG 2.2 AA mapping

The table maps Folio features to the success criteria they satisfy. This is a working map for contributors, not a formal conformance claim.

| Feature | WCAG 2.2 success criterion | Level |
|---|---|---|
| Text layer over each page (readable, selectable text) | 1.1.1 Non-text Content; 1.4.5 Images of Text | A / AA |
| Reading order from document text content | 1.3.2 Meaningful Sequence | A |
| Landmarks, roles, `aria-*` state | 1.3.1 Info and Relationships; 4.1.2 Name, Role, Value | A |
| UI contrast in light and dark themes | 1.4.3 Contrast (Minimum) | AA |
| Non-text/UI-component contrast, focus rings | 1.4.11 Non-text Contrast | AA |
| Fit width and application zoom (no loss at magnification) | 1.4.4 Resize Text; 1.4.10 Reflow | AA |
| Full keyboard operation, all actions as commands | 2.1.1 Keyboard | A |
| No keyboard trap; overlays trap-and-release correctly | 2.1.2 No Keyboard Trap | A |
| Character-key shortcut `?` avoids single printable-key conflicts in inputs | 2.1.4 Character Key Shortcuts | A |
| Skip-to-document link | 2.4.1 Bypass Blocks | A |
| Visible focus indicator (`--folio-focus`) | 2.4.7 Focus Visible | AA |
| Focus not obscured by toolbar/overlays | 2.4.11 Focus Not Obscured (Minimum) | AA |
| Logical, consistent focus order | 2.4.3 Focus Order | A |
| Reduced-motion handling | 2.3.3 Animation from Interactions | AAA (honored) |
| Consistent toolbar/menu placement and labels | 3.2.3 Consistent Navigation; 3.2.4 Consistent Identification | AA |
| Live-region status announcements | 4.1.3 Status Messages | AA |
| Accessible names on all controls | 2.5.3 Label in Name; 4.1.2 Name, Role, Value | A |

## Related documents

- `docs/architecture.md`: the command registry and a11y layer in context.
- `docs/theming.md`: token values, contrast, and reading-mode filters.
