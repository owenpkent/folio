# Folio Accessibility Guide

Accessibility is a first-class requirement in Folio, not a later pass. The target is **WCAG 2.2 Level AA**. This guide documents the concrete behaviors you can rely on and test against: the keyboard model, focus rules, ARIA structure, the text layer, live-region announcements, reading modes, reduced motion, zoom/reflow, and the automated plus manual testing approach.

The accessibility utilities live in `src/a11y/` (announcer, focus trap, keyboard shortcut dispatch, and the skip link). Because every user action is a `Command` with an optional `keybinding` (see `docs/architecture.md`), keyboard access and menu access run the exact same code path.

## Keyboard shortcuts

All shortcuts dispatch through the command registry (`useKeyboardShortcuts` matches the pressed chord against each command's declared `keybinding`). Bindings use `Mod`, which resolves to `Cmd` on macOS and `Ctrl` elsewhere, so the two platform columns differ only in that modifier.

Bindings are declared on the command, wherever that command lives — mostly `src/commands/defaultCommands.ts` and `src/features/annotations/commands.ts`, but `file.save` is declared in `src/features/export/saveDocument.ts`. `grep -rn "keybinding:" src/` is the complete list.

| Action | Command id | Windows/Linux | macOS |
|---|---|---|---|
| Open document | `file.open` | `Ctrl+O` | `Cmd+O` |
| Save a copy | `file.save` | `Ctrl+S` | `Cmd+S` |
| Next page | `nav.nextPage` | `→` | `→` |
| Previous page | `nav.prevPage` | `←` | `←` |
| Scroll down one screen | `nav.scrollDown` | `Page Down` | `Page Down` |
| Scroll up one screen | `nav.scrollUp` | `Page Up` | `Page Up` |
| First page | `nav.firstPage` | `Ctrl+Home` | `Cmd+Home` |
| Last page | `nav.lastPage` | `Ctrl+End` | `Cmd+End` |
| Zoom in | `view.zoomIn` | `Ctrl+=` | `Cmd+=` |
| Zoom out | `view.zoomOut` | `Ctrl+-` | `Cmd+-` |
| Actual size (100%) | `view.zoomReset` | `Ctrl+0` | `Cmd+0` |
| Toggle sidebar | `view.toggleSidebar` | `Ctrl+B` | `Cmd+B` |
| Find in document | `search.toggle` | `Ctrl+F` | `Cmd+F` |
| Close find | `search.close` | `Esc` | `Esc` |
| Highlight selection | `annotate.highlight` | `Ctrl+Shift+H` | `Cmd+Shift+H` |
| Add sticky note | `annotate.addNote` | `Ctrl+Shift+M` | `Cmd+Shift+M` |
| Toggle UI theme (light/dark) | `theme.toggle` | `Ctrl+Shift+L` | `Cmd+Shift+L` |

`Page Up`/`Page Down` are dispatched as commands rather than left to the browser. Native scrolling only acts on the focused element's nearest scrollable ancestor, so it stops working the moment focus moves to the toolbar or the find box; binding the keys keeps them working wherever focus happens to be.

`↑`/`↓`, unmodified `Home`/`End` and `Space` are unbound and scroll natively, which works because the viewer takes focus when a document opens and gets it back when the find bar closes. `←`/`→` do **not** scroll: they are bound to page navigation and the dispatcher calls `preventDefault()`, so they never reach the browser's own scrolling. That is a deliberate trade — paging is the more useful binding — but it means horizontal scrolling at high zoom needs the scrollbar, the hand tool, or shift-scroll.

These commands exist but have **no keyboard binding**; they are reachable from the toolbar (and via the registry) only:

| Action | Command id | Trigger |
|---|---|---|
| Close document | `file.close` | Command / menu |
| Set Folio as default PDF viewer | `file.setDefaultViewer` | Command (desktop only) |
| Fit width | `view.fitWidth` | Toolbar button |
| Fit page | `view.fitPage` | Toolbar button |
| Hand tool (pan to scroll) | `view.toggleHandMode` | Toolbar button |
| Cycle reading mode | `theme.cycleReadingMode` | Toolbar button |
| Edit text | `textedit.toggle` | Toolbar button |
| Add text box | `edit.addText` | Toolbar button |
| Add image | `edit.addImage` | Toolbar button |
| Recognize text (OCR) | `ocr.recognizeDocument` | Toolbar button |
| Recognize text on this page | `ocr.recognizePage` | Command |
| Add signature | `sign.addSignature` | Toolbar button / Signatures panel |
| Digitally sign | `sign.digitallySign` | Toolbar button / Signatures panel |
| Word Count (built-in plugin) | `plugin.wordCount.show` | Sidebar panel |

Every one of these is reachable by keyboard through its toolbar button or panel, so no functionality is keyboard-inaccessible (WCAG 2.1.1); they simply have no dedicated chord. The planned command palette is what makes them all directly reachable.

Planned, **not yet implemented** (no command is registered for these today): a command palette (`Ctrl/Cmd+Shift+P`) and an in-app keyboard-shortcuts help overlay (`?`). Every toolbar button whose command has a binding names it in the button's label, which is both its `aria-label` and its tooltip (`IconButton` sets the two from one `label` prop), so bindings stay discoverable until the help overlay lands. If you give an existing command a binding, add it to that label too.

Form fields and signatures: filled AcroForm fields are native HTML inputs, so they are keyboard-operable, and Folio names each one from the field's `/TU` (falling back to `/T`) — see [The text layer and screen readers](#the-text-layer-and-screen-readers) for why PDF.js does not do this on its own. A field with neither entry has no name to give, which is a defect in the source PDF rather than in the viewer. The signature dialog is a focus-trapped modal (dismiss with `Escape`), and placed signatures expose a keyboard-focusable delete button; keyboard placement and resizing of signatures are planned. Signatures and placed images carry **no alternative text** in the exported file, and there is no UI to supply one — a known gap, tracked in [508-conformance.md](508-conformance.md). See [forms-and-signatures.md](forms-and-signatures.md).

Editing text in place: the **Edit text** tool toggle (`textedit.toggle`) is a command reachable from its toolbar button, like the others above. Once it is on, clicking a run of text opens an inline editor: a focused `role="textbox"` with its own `aria-label`, committing on `Enter` and cancelling on `Escape` like a native control. Choosing *which* run to edit is pointer-only today: the hit target is sized to the page and keyed to click coordinates, with no keyboard-driven way to tab between editable runs. See [editing-and-ocr.md](editing-and-ocr.md#editing-existing-text).

Everything reachable by mouse is reachable by keyboard. If you add a feature, add its command with a `keybinding` rather than wiring a bespoke key handler.

## Focus management rules

Focus is deliberate, visible, and never lost. Rules enforced by `src/a11y` focus management:

- **Visible focus rings, always.** Focus is styled with the `--folio-focus` token and is never removed (no `outline: none` without a replacement). Rings meet the 3:1 non-text contrast requirement in every theme and reading mode.
- **Logical tab order.** DOM order matches visual order: skip link → Toolbar → Sidebar (when open) → page viewport. Tabbing never jumps unpredictably.
- **Focus trapping in overlays.** Transient surfaces use the `useFocusTrap` helper in `src/a11y/focus.ts`, which cycles `Tab`/`Shift+Tab` within the container and restores focus to the opener on close. The search bar focuses its input when it opens and closes on `Escape`; the planned command palette will use the same helper.
- **Focus restoration.** When an overlay closes, focus returns to the element that opened it. Closing the find bar and committing the page box both return focus to the page viewport (`focusViewer` in `src/state/viewerElement.ts`) rather than dropping it on `<body>`, which would leave the scroll keys with no scrollable element to act on.
- **The viewport takes focus when a document opens**, for the same reason: the app shell is `overflow: hidden`, so a scroll key that reaches `<body>` does nothing at all.
- **The skip link targets the scroller itself**, not its `<main>` wrapper. The browser scrolls the focused element's nearest scrollable *ancestor*, and `<main>` is a non-scrolling parent of the viewer, so skipping to it would land focus somewhere the scroll keys are dead.
- **No keyboard traps in content.** The page viewport is a single focus stop; you can always `Tab` past it. Within a page you navigate text with normal caret/selection keys, not by tabbing through every word.
- **Skip to content.** A visually-hidden "Skip to document" link is the first focus stop, letting keyboard and screen-reader users bypass the toolbar.

## ARIA landmarks and roles

Folio exposes a stable landmark structure so screen-reader users can navigate by region.

| Region | Element/role | ARIA |
|---|---|---|
| Top toolbar | `<header role="banner">` | icon buttons carry `aria-label` (for example "Toggle sidebar (Ctrl/Cmd + B)", "Zoom in (Ctrl/Cmd + =)"); the live zoom readout uses `aria-live="polite"` |
| Sidebar (outline, thumbnails, annotations) | `<aside>` (complementary) | `aria-label="Document tools"`; the rail is `role="tablist"` with `aria-orientation="vertical"`, each tab is `role="tab"` with `aria-selected` and a roving tabindex, and the body is `role="tabpanel"` |
| Page viewport | `<main>` | `aria-label="Document"` |
| Search bar | `role="search"` | labeled input, `aria-live` result count |
| Announcer (polite) | visually hidden `role="status"` | `aria-live="polite"`, `aria-atomic="true"` |
| Announcer (assertive, errors) | visually hidden `role="alert"` | `aria-live="assertive"`, `aria-atomic="true"` |

There is no separate status-bar landmark today: the current page (an editable page box) and the current zoom percentage live in the toolbar, with the zoom readout in an `aria-live="polite"` region. A dedicated status bar is planned.

Additional roles in the sidebar panels: thumbnails present a selectable list, each with `aria-current="page"` for the page in view; toolbar toggles expose their state via `aria-pressed`; the reading-mode control exposes its current mode in its label.

The sidebar rail is a real tablist: it uses a roving tabindex, so `Tab` steps over the rail as one stop and `↑`/`↓` (and `←`/`→`, and `Home`/`End`) move between tabs, with selection following focus. That handler is load-bearing rather than a nicety — a roving tabindex without it leaves every unselected panel unreachable by keyboard.

**Known gap — the outline is not a tree.** `Outline.tsx` renders nested `<ul>`/`<li>` with a button per entry and `aria-expanded` on the expand/collapse toggle, not `role="tree"` / `role="treeitem"`. It is fully keyboard navigable and every control is named, but a screen reader announces it as a list rather than a tree, so it carries no level or set-position information. Making it a real tree means the ARIA roles plus arrow-key navigation over the same roving-tabindex pattern the rail now uses.

## Names and tooltips

Folio has no tooltip component: tooltips are native `title` attributes. `IconButton` (`src/components/common/IconButton.tsx`) takes one required `label` and sets **both** `aria-label` and `title` from it, so anything rendered through it is named for screen readers and hoverable for everyone else. Prefer it over a raw `<button>` for icon-only controls; a raw button with only `aria-label` is named but silent on hover, which is the gap sighted mouse users feel.

Nothing enforces the pairing, so two rules are worth keeping in mind:

- **Icon-only or single-glyph controls need both.** A "B" for bold or an "×" for close does not explain itself.
- **Text that can be clipped needs a `title` carrying the full string.** Search snippets, outline entries and annotation rows are all truncated by CSS, so hovering is the only way to read the rest. The same applies wherever a label is *replaced* by user content: the signature font picker renders your typed name in each font, which hides the font's own name, so it carries an explicit `title` and `aria-label`.

## The text layer and screen readers

Each rendered page is a `<canvas>` (the visual raster) with a **positioned text layer** overlaid on top, built by `PdfEngine.renderTextLayer(pageNumber, container, { scale })` from PDF.js text content (the same text is available to search and the AI layer via `getPageText`). This is the core of Folio's accessibility.

- **Real text, not an image.** The text layer contains the document's actual glyphs positioned over the canvas. Screen readers read this text; users select and copy it; find-in-page highlights it.
- **Selection matches the visual page.** Because text spans are positioned to align with the raster, a selection drag looks correct and yields the correct copied text.
- **Reading order is content-stream order, not logical order.** Folio does not currently read the PDF's structure tree: `renderAnnotationLayer` passes `structTreeLayer: null`, `page.getStructTree()` is never called, and the text layer is positioned spans with no structure attached. So the order comes from `getTextContent()`, which follows the content stream, **even for a tagged PDF whose tags describe a different logical order**. For most documents the two coincide; for multi-column layouts, sidebars and floated figures they do not. Closing this means wiring PDF.js's `StructTreeLayerBuilder` and accessibility manager, and is the largest open item in this guide. See [508-conformance.md](508-conformance.md).
- **The canvas is decorative to assistive tech.** The raster carries `aria-hidden="true"` (`src/components/Viewer/Page.tsx`) so screen readers do not announce it as an image; the text layer is the accessible representation.
- **Form fields are named from the PDF.** PDF.js renders AcroForm widgets as native inputs but leaves them unnamed — it only applies ARIA from a structure tree, and the field's `/TU` goes on the wrapping `<section>` as a `title`, which does not name the input inside it. `nameFormWidgets` (`src/core/pdf/PdfJsEngine.ts`) sets `aria-label` on each control from the field's `/TU`, falling back to `/T`. An end-to-end test asserts this through the accessible-name computation rather than the attribute.

## Live-region announcements

State changes that are obvious visually but silent to a screen reader are announced through the live regions in `src/a11y/announcer.ts`. Each call clears the region first and writes the new text on the next animation frame, so an identical consecutive message is still re-announced and a burst of rapid updates coalesces to the latest value.

There are around three dozen announcements; `grep -rn "announce(" src/` is the authoritative list, since any table here would drift. Representative examples, with their exact wording:

| Event | Announcement |
|---|---|
| Page change | `Page 5 of 24` |
| Zoom change | `Zoom 150 percent` |
| Reading mode | `Reading mode: Night` (the capitalized mode label) |
| Theme change | `dark theme` / `light theme` (the resolved theme) |
| Document opened via the picker | `Opened report.pdf, 24 pages` |
| Document closed | `Closed document` |
| Highlight added | `Highlight added` |
| Hand tool toggled | `Hand tool on` / `Hand tool off` |
| Note placed | `Note added on page 3` |
| Signature placed | `Signature placed. Drag it to reposition…` |
| Saved a copy | `Saved report (filled).pdf` / `Downloaded report (filled).pdf` |
| OCR finished | `Text recognition complete` |

One inconsistency worth knowing: a document opened from a **deep link or an OS file association** announces `Opened report.pdf` without the page count (`openFromDeepLink.ts`, `openFromLaunch.ts`), where the picker path includes it.

The polite region (`role="status"`, `aria-live="polite"`) never interrupts the user mid-sentence. Messages that need attention go to a separate assertive region (`role="alert"`, `aria-live="assertive"`) instead — that is what the `true` second argument to `announce()` selects. Assertive today: failures (`Could not open document: …`, `Could not save the document: …`, `Could not create the certificate`) and instructions the user must act on before anything happens (`Select some text first, then add a highlight`, `Create a signature first`, `Enter a name and a passphrase`).

The find-in-page result count is a separate `aria-live="polite"` region inside the search bar (not routed through the announcer); it reads `3 of 17`, `Searching…`, or `No results`. Fit-mode changes and sidebar toggles are not currently announced.

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
- Zoom level is announced (`Zoom 150 percent`) and shown as a live `150%` readout in the toolbar so it is perceivable without relying on the visual size change alone.

## Testing approach

Accessibility is verified continuously, not audited once.

**Automated (in CI):**

- **eslint-plugin-jsx-a11y** flags missing labels, unsupported ARIA, and other markup issues on every push and pull request (see the `quality` CI job).
- **Vitest** unit tests cover keyboard-shortcut dispatch (chords, the typing-in-input guard, and `when()` gating) and the stores behind accessible state.
- **Playwright** end-to-end tests drive real keyboard and pointer flows in a browser (open, render, fill a form, sign), including `Page Up`/`Page Down` scrolling both with focus in the document and after it has moved to the toolbar. See [testing.md](testing.md).

Planned: **axe-core** violation scanning wired into the end-to-end suite across views (viewer, sidebar open, search open, each reading mode, light and dark), plus unit tests for the announcer (polite vs assertive) and focus trap/restore. These are not yet implemented.

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
| Shortcuts are suppressed while typing in text inputs, `textarea`, `select`, or contenteditable (except `Escape`), avoiding printable-key conflicts | 2.1.4 Character Key Shortcuts | A |
| Skip-to-document link | 2.4.1 Bypass Blocks | A |
| Visible focus indicator (`--folio-focus`) | 2.4.7 Focus Visible | AA |
| Focus not obscured by toolbar/overlays | 2.4.11 Focus Not Obscured (Minimum) | AA |
| Logical, consistent focus order | 2.4.3 Focus Order | A |
| Reduced-motion handling | 2.3.3 Animation from Interactions | AAA (honored) |
| Consistent toolbar/menu placement and labels | 3.2.3 Consistent Navigation; 3.2.4 Consistent Identification | AA |
| Live-region status announcements | 4.1.3 Status Messages | AA |
| Accessible names on all controls | 2.5.3 Label in Name; 4.1.2 Name, Role, Value | A |

## Related documents

- `docs/508-conformance.md`: how Folio maps to the Revised 508 Standards, which incorporate WCAG 2.0 A/AA by reference, plus the provisions WCAG does not cover (platform settings, authoring tools, support documentation) and the open gaps.
- `docs/architecture.md`: the command registry and a11y layer in context.
- `docs/theming.md`: token values, contrast, and reading-mode filters.
