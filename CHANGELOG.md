# Changelog

All notable changes to Folio are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Documentation sweep after 0.5.0.** The stack table, the setup guide, the
  contributing guide, and the architecture doc all still said React 18; the
  in-place image tool was still described as living on the toolbar rather than in
  the Edit menu; and the source-tree listing was missing `components/MenuBar`.
  Corrected, along with a broken relative link in `CLAUDE.md` that pointed into
  the security-tooling repo.
- **The per-page overlay stack is now documented**
  ([architecture.md](docs/architecture.md#the-per-page-overlay-stack)), with the
  rule that keeps catching people out: a tool that covers the page with a
  click-catcher sits *above* the forms layer, which only takes pointer events over
  each field's own rect, so without the shared `formWidgetAt` hit-test any armed
  tool makes form fields unfillable. Three tools do this and one of them inverts
  the rule on purpose.
- **`npm audit` guidance now points at the known-accepted list.** "Treat
  high/critical as blocking" was becoming impossible to follow literally: the
  gate that blocks a release is Dependabot, and `npm audit` additionally reports
  findings that cannot be fixed from this repository at all
  ([#57](https://github.com/owenpkent/folio/issues/57),
  [#58](https://github.com/owenpkent/folio/issues/58)). The Dependabot section
  also described major upgrades as never grouped, which stopped being true when
  cohort grouping landed.
- **The Playwright browser gotcha is documented** in
  [testing.md](docs/testing.md) and the release checklist: the binary must be
  reinstalled after any `@playwright/test` upgrade, or every spec fails at 0ms on
  a missing executable, which reads as a catastrophic regression and is not one.

### Security

- **Updated `postcss` to 8.5.24 and the VS Code extension's `esbuild` to 0.25**,
  clearing the two Dependabot alerts that appeared once alerts were enabled for
  the repository. Both are development-only dependencies and neither ships in a
  built artifact: postcss arrives transitively through Vite
  ([GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849), path
  traversal in source-map auto-loading), and esbuild is the extension's bundler
  ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), dev
  server request handling). The postcss one was a **high**, which the release
  checklist gates on, so it would have blocked the next release.


## [0.5.0] - 2026-07-28

### Added

- **Move, resize, and delete any placed item from the keyboard.** Dragging and
  the corner handle were the only way to position a text box, a placed image, a
  check mark, a signature, or an embedded image, which is a WCAG 2.1.1 failure
  repeated across five features. Every one of them is now focusable and responds
  to the arrow keys (one screen pixel, ten with **Shift**), `+`/`-` to resize,
  and **Delete** to remove. One implementation serves all five, so the bindings
  cannot drift apart. Steps are screen pixels of the rendered page rather than
  PDF points, matching how the drag handlers already worked: zoom in for finer
  control. Arrows typed inside a text box still move the caret, and a nudge does
  not also scroll the document. Announcements are debounced, so a run of presses
  reports where the item ended up instead of flooding a screen reader per key.
  Aspect ratio stays locked wherever the pointer locks it, and a resize that
  would push one axis past its limit is refused whole rather than silently
  reshaping the item.
- **Application menu bar.** A classic File / Edit / View / Annotate / Sign /
  Tools / Help menu row above the toolbar, built in-app (pure DOM, so it is
  identical in the desktop app, the browser build, and the VS Code extension)
  and driven by the command registry: each item executes the same command its
  toolbar button did, shows the command's declared shortcut, and disables when
  the command cannot run. Implements the full ARIA menubar keyboard pattern
  (roving tab stop, arrow keys across and within menus, Home/End, Escape,
  hover-slide between open menus). On narrow windows it folds into a single
  hamburger Menu button with grouped rows. The Tools menu hosts
  plugin-contributed commands and hides when no plugin contributes any.
- **Thumbnails follow the current page.** The sidebar thumbnail strip scrolls
  its highlighted page into view as you move through the document, using
  nearest-edge scrolling so it never jumps when the thumb is already visible,
  and stands down for a moment while you scroll the sidebar by hand.
  Respects `prefers-reduced-motion`.
- **Recent signature names.** The Type tab of the signature dialog remembers the
  last five names you signed with (and the style you picked for each), offers
  them as one-click chips, and prefills the most recent one, so signing a second
  document no longer means retyping your name. Stored locally, text and font
  only, never the rendered image.
- **Text inside Form XObjects is now editable.** The content-stream parser
  descends into `Do`-invoked Form XObjects, composing each form's own
  `/Matrix` with the transform at the invocation site, so text placed by a
  template, a letterhead, or a form generator can be clicked and replaced like
  any other run. Previously all of it reported "cannot be edited", which read
  as though the page were a scan even when the text was ordinary vector text.
  An edit never rewrites the form in place: the same form can be drawn by
  other pages, so the whole chain from the edited form up to the page is
  copied and only this page's resources are redirected at the copy. Text in a
  form the page draws more than once is still refused, because removing it
  would clear every copy while the replacement is drawn only once.
- **Check marks.** A mark placed by clicking a spot on the page, for forms that
  show a printed box with no interactive field behind it. Selecting a placed
  mark offers a check or a cross. It goes through the same click-to-place mode
  as text boxes, images, and signatures, with one difference: a click that lands
  on a *real* form widget reaches the widget instead, since a mark exists only to
  stand in for a checkbox that has no field. Like the other placement tools, a
  mark is an overlay until you save, then it is baked as a stroked vector path,
  so it stays sharp at any zoom.
- **Select, move, resize, replace, and delete images already in a PDF.** A new
  **Edit images** tool, in the Edit menu beside *Edit text*, lets you click an image
  already drawn on a page, then drag it, resize it from the corner, delete it,
  or replace it with a different PNG/JPEG, committing immediately the same way
  in-place text edits do, rather than waiting for a save. A move or resize
  rewrites the page's `/Name Do` operator in place with a new matrix, keeping
  the graphics state and z-order exactly as they were; a replace embeds the
  new image under a fresh resource name and repoints only that operator, so
  the original image XObject (and any other page still drawing it) is never
  touched. Rotated or skewed images can still be replaced in place but not
  moved or resized, and an image inside a Form XObject is not editable yet.

### Changed

- **Text boxes, images, signatures, and check marks are placed where you
  click.** Adding one no longer drops it in the middle of the page for you to
  drag into position:
  the tool arms a click-to-place mode (with a banner; Escape, the banner's
  Cancel, or a click anywhere off a page backs out) and the next click on a page
  decides where the item lands. Text boxes start at the click, images and
  signatures land centered on it. Picking a spot is a pointer affordance, so the
  banner takes focus and carries the keyboard path: **Place in the middle**
  centers the item on the current page, which is what these tools did before.
- **A text box moves by dragging anywhere on it.** The narrow grip above the box
  is gone; press anywhere on the box and drag. A press that does not travel is
  still a plain click, so selecting a box and placing the caret work as before.
- **The toolbar slimmed down.** With the menu bar carrying the full command
  set, the toolbar's right side keeps only Save and Find next to the pinned
  theme controls and About; comment, highlight, edit text, edit images, add text
  box, add image, add check mark, OCR, both signature actions, save a copy, and
  plugin buttons all live in the menus.
- **Upgraded to React 19** (`react`, `react-dom`, and both `@types` packages
  together). No source changes were needed: no removed React 18 API is used
  anywhere, and no ref callback returns a value, which is the React 19 change
  least likely to be caught by a test suite since a returned value is now treated
  as a cleanup function. Also picks up grouped GitHub Actions and Cargo
  dependency bumps.

### Fixed

- **The densest displays no longer render below their own pixel density**
  ([#29](https://github.com/owenpkent/folio/issues/29)). The backing-store scale
  aimed for "at least 2x, at most 3x", so a panel reporting a `devicePixelRatio`
  above 3 was handed a 3x render that it then had to stretch. The 3x ceiling is
  gone: the target is now the greater of 2x and the display's own ratio, bounded
  by the canvas pixel budget, which was always the real limit. The earlier half
  of this issue — a `Math.min(1, dpr)` floor that could both under-render *and*
  bust the budget — was already fixed; the docs and an old release note that
  still claimed the render was never below the display ratio are corrected here.
- **Re-render on DPI change now works on fractional-scaling displays**
  ([#30](https://github.com/owenpkent/folio/issues/30)). Detection built a
  `matchMedia('(resolution: Xdppx)')` query by interpolating
  `window.devicePixelRatio`, relying on it evaluating true so that any change
  would flip it false and fire. Windows at 133% reports 1.3333333333333333, and
  an equality query built from a float like that may never evaluate true — and a
  query that starts false never flips, so dragging a window between monitors left
  pages baked at the old ratio and visibly blurry. Exactly the displays the
  feature exists for. It now brackets the ratio with a range query, true by
  construction whatever the float, and falls back to a low-frequency poll if even
  that fails to match rather than silently doing nothing a second time.
- **Green and Amber dark schemes now apply to thumbnails.** Sidebar previews
  used a plain CSS invert, so they stayed white-on-black while the page showed
  the selected scheme. Thumbnails now render through the same raster-time
  invert-and-tint path as the page (`renderPage` `invert`/`tint`) and re-render
  when the theme or scheme changes, so the strip always matches the page.
- **Signatures, text boxes, images, annotations, and the OCR layer no longer
  render twice after saving and reopening a document.** Overlay content is
  kept in a per-document sidecar keyed by the PDF fingerprint, which PDF.js
  derives from the trailer `/ID`. Saving baked that content into the page but
  carried the source `/ID` through unchanged, so the saved file kept its
  source's fingerprint and reopening it loaded the same sidecar back on top of
  content already in the page. A flattened export now gets its own document
  identity. One consequence worth knowing: overlay content in a reopened
  export is part of the page, so it can no longer be dragged or deleted, the
  same way Acrobat treats flattened content.
- **Form fields stay clickable while an editing tool is armed.** Edit text, Edit
  images, and any armed placement each cover the whole page with a
  click-catcher, and all of them sit above the form layer, which only takes
  clicks over each field's own rect. Any of them would swallow a click meant for
  a checkbox, radio button, or text field. A click that lands on a widget now
  reaches the widget instead.
- **Clicking an image Folio cannot edit explains why.** The Edit images tool
  ignored a click on an image inside a Form XObject without saying anything,
  the same silent dead end that made the original text-editing problem so hard
  to place. Such an image is now selected and the reason shown. Dragging one
  is refused up front, rather than tracking the pointer and snapping back on
  release.
- **Sticky note pins open from the keyboard.** A pin is a focusable button
  that announces the note it holds, but it opened the note only on
  `pointerup`, which is what lets that handler tell a click apart from the end
  of a drag. Keyboard activation fires no pointer events, so `Enter` and
  `Space` on a focused pin did nothing at all, a WCAG 2.1.1 failure on a
  control that named itself as actionable.

### Security

- **The content-stream parser bounds how much work one document can make it
  do.** Descending into Form XObjects checks for cycles along the current path
  only, so a form reached down a different branch is descended into again. A
  document whose forms each invoke the next one several times therefore cost
  fan-out to the power of the depth limit in stream traversals, enough to hang
  the tab on a file the user only meant to open. Total descents per parse are
  now capped, well above what real documents use.

## [0.4.0] - 2026-07-23

### Changed

- **The Green dark scheme now uses the Linux console's bright ANSI green**
  (`#55FF55`) instead of a pastel mint (`#4ADE80`), so green-on-black pages
  read like a classic terminal.

### Added

- **Save in place.** `Ctrl/Cmd + S` now saves back to the file the document was
  opened from (file picker, launch file, or desktop drag-and-drop), instead of
  always prompting for a new path. "Save a copy…" moved to
  `Ctrl/Cmd + Shift + S`, with its own toolbar and context-menu entries. When
  there is no writable origin (the browser build, fetched URLs, browser
  drag-and-drop), Save falls back to the save-a-copy dialog.
- **Splash screen.** The empty state now leads with the Folio mark and
  wordmark, and the open-a-document controls appear only once startup file
  handling has settled, so opening a PDF by double-clicking it no longer
  flashes the open UI before the document loads. Animations respect
  `prefers-reduced-motion`.
- **Mobile mode.** Narrow windows now get a phone-friendly layout instead of a
  squashed desktop one. At 640px and below, the sidebar becomes an overlay
  drawer over the document (it starts closed, a tap on the dimmed area or
  pressing `Esc` dismisses it, and picking a thumbnail or outline entry
  navigates and closes it), and the toolbar folds the filename, the theme
  controls, About, and the secondary view tools (fit width/page, hand tool,
  auto-scroll) into the **More** menu as labeled rows, so every control stays
  reachable. At 480px and below, zoom in/out and the zoom readout fold as
  well. Coarse (touch) pointers get 40px hit targets. Toolbar icon buttons no
  longer flex-shrink when space runs out; squeezed buttons also distorted the
  width measurement that decides what collapses into the menu. Breakpoints
  live in `src/theme/breakpoints.ts`, and `e2e/mobile.spec.ts` pins the
  drawer and no-clip behavior at a phone viewport.
- **The built-in Word Count plugin now has a toolbar trigger.** Its
  `plugin.wordCount.show` command was registered but wired to no UI,
  contradicting the accessibility guide's promise that every command without a
  shortcut is reachable from the toolbar or a panel. The plugin now
  contributes a toolbar item, which also puts the worked example in
  docs/plugins.md back in line with the real source.

### Fixed

- **Saves are atomic.** `write_document` now writes to a randomly named temp
  file in the destination directory and renames it over the target, so a crash
  or full disk mid-save can no longer leave a truncated PDF. This matters now
  that Save writes back to the opened document rather than only to new copies.
- **"Make Folio your default PDF viewer" reliably opens Windows Settings.**
  The `ms-settings:` deep link is now launched through ShellExecute (a hidden
  `cmd /C start`) instead of `explorer.exe`, which dropped the URI's query on
  some Windows builds and opened the default web browser instead.
- **The page indicator stays on one line when the toolbar is squeezed.** In a
  narrow window the "/ N" page count could wrap, landing the slash above the
  count and mis-centering the page input. The toolbar now enforces
  `white-space: nowrap` on itself and pins the page box so it neither shrinks
  nor wraps, and `e2e/toolbar.spec.ts` guards the single-line indicator and
  the toolbar's fixed height.

### Security

- **CI verifies the sha256 digests of the release binaries it downloads.**
  The security workflow installs gitleaks and reviewdog from GitHub releases;
  those tarballs are now pinned to the digests from each release's
  `checksums.txt` (independently re-verified against the artifacts), and the
  install fails on a mismatch. A version tag on a GitHub release is mutable;
  the digest is not. The downloads also retry transient network faults
  instead of failing the whole job.

## [0.3.1] - 2026-07-20

### Fixed

- **Toolbar controls no longer clip off narrow or high-DPI windows.** The
  right-hand tools (theme, About, save, find, …) used to spill past the window
  edge, unreachable, on narrower or fractionally-scaled displays (the toolbar
  held a fixed ~1345px intrinsic width). The open document's filename now
  truncates first, and the auto-scroll speed slider only occupies toolbar width
  while auto-scroll is active, so the tools stay inline down to ~960px.

### Added

- **Toolbar overflow menu.** Below the inline-fit width, the right-hand document
  tools (comment, highlight, edit text, add text box, add image, OCR, add
  signature, digitally sign, save a copy, find) collapse into a **More** (⋯)
  dropdown instead of being clipped, and appear there as labeled rows. The
  dark-scheme picker, light/dark toggle, and About stay pinned and always
  visible. The set shown inline adjusts live as the window resizes.

## [0.3.0] - 2026-07-20

### Security

- **Hardened the `fetch_pdf` browser hand-off against SSRF.** The `folio://`
  deep link can be triggered by any web page, so the download command now
  resolves the target host and rejects the request if any resolved IP is
  loopback, private, link-local (including the `169.254.169.254` cloud-metadata
  endpoint), carrier-grade NAT, benchmarking, reserved, or multicast — across
  IPv4, IPv6, and IPv4-mapped IPv6. Validating resolved IPs rather than the URL
  string defeats decimal/hex/octal encodings and DNS names that point at private
  space. The connection is pinned to the pre-validated IPs (closing the
  DNS-rebinding window), follows no redirects (so a public URL cannot bounce to
  an internal host), and enforces connect/read timeouts.
- **Tightened the desktop Content Security Policy** with `frame-ancestors 'none'`
  and `form-action 'none'`, closing the framing and form-submission vectors.
- **Upgraded `ureq` 2.x → 3.x** and reimplemented the `fetch_pdf` SSRF guard on
  its new API: the pre-validated addresses are now pinned through a custom
  `Resolver` (`Agent::with_parts`), redirects are disabled via `max_redirects(0)`,
  and the body size ceiling is enforced with `Body::with_config().limit(...)`.
- **Pinned the OCR language-model download to a SHA-256 digest.**
  `scripts/setup-ocr-assets.mjs` fetches `eng.traineddata.gz` at setup time; it
  now verifies the download against a pinned hash *before* writing it to
  `public/tesseract/` and re-verifies a cached copy on every run, so a tampered,
  truncated, or MITM'd model never lands on disk. The pinned `.gz` decompresses
  byte-for-byte to the authoritative `tessdata_fast` 4.0.0 English model
  (provenance recorded inline in the script).

### Added

- **Edit text in place**: a new **Edit text** tool (pencil icon, the
  `textedit.toggle` command) that lets you click text already on a page and
  replace it. Unlike the existing additive text-box tool, this is true in-place
  editing: the original show-text operator is located and removed from the
  page's content stream, and the replacement is drawn at the same spot, taking
  effect as soon as you commit the edit rather than waiting for a save.
  Replacement text uses a substituted Standard 14 font rather than the
  document's own embedded font; rotated or skewed text, text inside Form
  XObjects, and characters the standard fonts cannot encode are refused with a
  toast instead of risking a corrupt file. `Ctrl/Cmd + Z` undoes up to 10 edits.
  New `src/features/textedit` module, two new `PdfEngine` methods
  (`getPageViewport`, `getTextItems`), and a `docVersion`-driven live reload of
  the open document. See docs/editing-and-ocr.md.
- **Hand (pan) tool**: a grab tool in the toolbar (and the `view.toggleHandMode`
  command) that lets you click-drag the page to scroll. Text selection is
  suppressed while it is active; form fields and placed edits still work.
  Dragging tracks the cursor 1:1 (the viewer's `scroll-behavior: smooth` is
  disabled while grabbing, so scrolling is instant rather than eased).
  Middle-mouse-button drag now pans the page the same way in **any** mode, hand
  tool on or off, and the browser's own middle-click autoscroll is suppressed
  so it doesn't fight with it.
- **Continuous auto-scroll**: a teleprompter-style scroll, toggled with a new
  toolbar button (in the center group next to the hand tool) or the
  `view.toggleAutoScroll` command. Speed ranges 4-160 px/s (`autoScroll`,
  `autoScrollSpeed` in `viewerStore`, default 12), set with a geometric,
  slow-weighted slider that appears next to the button for finer control at low
  speeds. While running, `Esc` stops it and `ArrowUp`/`+` and `ArrowDown`/`-`
  speed it up or slow it down; it pauses automatically while hand-panning and
  stops on its own at the end of the document. Motion is smooth, sub-pixel
  scrolling rather than a fixed per-frame jump.
- **Right-click context menu**, Acrobat-style (new `src/features/contextmenu`
  module): Select tool / Hand tool (with a checkmark on whichever is active),
  Copy (selection), Highlight, Add comment, Add text box, Add image, Add
  signature, Find, and Save a copy. It duplicates existing toolbar commands
  rather than adding new behavior, and editable targets (form inputs, the note
  editor) keep the browser's native context menu.
- **The open document's filename** now shows in the toolbar's left group, next
  to the open button, truncated with an ellipsis with the full name available
  on hover.
- **About dialog** (`help.about` command, an info (i) toolbar icon,
  `src/features/about/AboutModal.tsx`): shows the app version, the git commit
  hash, the build date, and the display's `devicePixelRatio` and window size.
  Version/commit/date are injected at build time via Vite `define`
  (`__APP_VERSION__`, `__COMMIT_HASH__` from `git rev-parse --short HEAD`,
  falling back to "unknown", and `__BUILD_DATE__`; see `vite.config.ts` and
  `src/vite-env.d.ts`). The dialog also has a manual "Check for updates"
  button (`help.checkForUpdates`, desktop/Tauri only) that reuses the existing
  `checkForUpdates(false)` path so it reports both "up to date" and error
  outcomes via toast, not just a found update; the silent launch-time update
  check is unchanged.
- **Zoom now snaps to clean preset levels** - 25 / 50 / 75 / 100 / 125 / 150 /
  200 / 300 / 400 / 600 / 800% - via `zoomIn`/`zoomOut`, instead of an
  arbitrary step. The overall 25%-800% clamp is unchanged, and fit-width /
  fit-page still compute an exact scale rather than snapping.
- **Selectable dark reading schemes**, Acrobat-style: **Night** (plain
  white-on-black), **Green**, and **Amber**, chosen from a new toolbar dropdown
  (`DarkSchemeMenu`) next to the light/dark toggle. The choice is tied to dark
  mode - light mode always shows the page as authored - and is persisted
  (`darkScheme` in `themeStore`, `folio.darkScheme` in local storage, default
  `night`).
- **`Page Up` / `Page Down` scroll the document**, as the `nav.scrollUp` /
  `nav.scrollDown` commands. They are bound as commands rather than left to the
  browser so they keep working wherever focus happens to be.
- **Tooltips on the remaining controls**: both modal close buttons, the toast
  dismiss, the text/image/signature delete and resize handles, the text
  inspector's font, size, bold and color controls, note pins, thumbnails and the
  outline chevron. Rows whose text is clipped (search results, outline entries,
  annotation rows) now reveal it on hover, as does the signature font picker,
  whose label is replaced by the typed name.
- **The sidebar, page and zoom buttons now name their shortcut** in their
  tooltip, like the rest of the toolbar already did.
- **Windows High Contrast (and any forced-colors mode) is now supported.**
  Design tokens resolve to the user's own system colors, shadows are dropped,
  toggled controls keep an outline so their state survives the palette being
  flattened, and the rendered page opts out of recoloring so a document still
  looks like its author wrote it.
- **UI text scales with the OS/browser font-size preference.** Font sizes moved
  from hardcoded `px` to `rem`; the default appearance is unchanged. Together
  with the above this covers Section 508 **503.2**, which requires honoring
  platform color, contrast and font settings and has no WCAG equivalent.

### Fixed

- **Highlights and sticky notes are no longer dropped when you save.** The export
  read the edit, signature and OCR stores but never the annotation store, so
  every highlight and note stayed in browser-local storage and never reached the
  file. They are now written as real `/Highlight` and `/Text` annotations
  carrying their text in `/Contents`, rather than flattened into the page
  graphics — so other readers can see, edit and reply to them, and assistive
  technology can read them. Annotated pages also get `/Tabs S` (ISO 14289-1
  7.18.3).
- **The sidebar panels are reachable by keyboard again.** The tab rail used a
  roving tabindex (only the selected tab in the tab sequence) but had no
  arrow-key handler, so `Tab` stepped over the whole rail and nothing moved
  between tabs: four of the five panels could not be reached by keyboard at all,
  a WCAG 2.2 SC 2.1.1 (Level A) failure. `↑`/`↓`, `←`/`→` and `Home`/`End` now
  move between tabs, with selection following focus.
- **Form fields are no longer unlabeled.** PDF.js renders AcroForm widgets as
  native inputs but never names them: it applies ARIA only from a structure tree
  (which Folio does not use), and the field's `/TU` lands on the wrapping
  `<section>` as a `title`, which does not name the input inside it. Every field
  was an anonymous edit box to a screen reader, even in a correctly authored PDF
  — a WCAG 2.2 SC 4.1.2 (Level A) failure. Each control now takes its
  `aria-label` from the field's `/TU`, falling back to `/T`.
- **The page canvas is now `aria-hidden`**, as the accessibility guide always
  claimed it was. The text layer over it is the accessible representation.
- **Filled form fields no longer render doubled and unreadable.** Field values
  were rasterised into the page canvas *and* rendered as HTML inputs on top of
  it, so both copies showed at once. The canvas render now passes
  `annotationMode: ENABLE_FORMS`, which is what makes PDF.js leave widgets to the
  annotation layer. Thumbnails, which have no input overlay, still paint values
  into the canvas as before.
- **Form fields could also be duplicated outright on a cold open.** Nothing
  cancelled or serialised annotation-layer renders, so the fit-to-width scale
  change landing mid-render let two passes interleave their appends into one
  container and leave duplicate widgets stacked on each other. Layer renders are
  now serialised per container and skip superseded passes. This was timing
  dependent, which is why it tended to appear on a first open and not a reopen.
- **The scroll keys did nothing until you clicked the page.** Focus stayed on
  `<body>`, which cannot scroll, so arrows, `Home`/`End` and `Space` were dead on
  arrival; opening find or the page box took focus away and never gave it back.
  The viewer now takes focus when a document opens and gets it back when those
  close, and the skip link points at the scroller instead of its non-scrolling
  `<main>` wrapper.
- **`Ctrl+F` could not close the find bar** from inside its own input.
- **Fit-to-width** no longer overflows or flickers a horizontal scrollbar. The
  viewer reserves the scrollbar gutter (`scrollbar-gutter: stable`), so the fit
  width stays stable even when the vertical scrollbar appears after a fit.

### Changed

- **Dark mode is now unified across the UI and the page**, instead of a
  separate reading-mode setting. The single light/dark/system toggle
  (`theme.toggle`) darkens the UI chrome and inverts the rendered page
  together. The old **normal / night / sepia / high-contrast reading modes**
  are removed entirely, along with the `theme.cycleReadingMode` command, the
  `data-reading-mode` attribute, and the contrast toolbar button that cycled
  between them: night is effectively folded into the dark theme, and sepia and
  high-contrast are gone. Page inversion moved from a CSS `filter` on the page
  canvas, which some rendering engines re-rasterized and blurred at CSS
  resolution, to a `globalCompositeOperation: 'difference'` fill applied
  directly on the canvas in `PdfJsEngine.renderPage`, at the canvas's full
  backing-store resolution, so dark pages are now sharp instead of soft.
  Thumbnails still use the old CSS filter, since they're small enough that the
  blur was never visible there. See the new **selectable dark reading
  schemes** entry above and docs/theming.md.
- **Rendering overhaul for crisper text on high-DPI and fractional-scaling
  displays.** Page canvases now render above the display's own pixel density
  (targeting roughly 2x, minimum 2, maximum 3) and are downsampled into the
  page's layout size, capped by a pixel budget (`MAX_CANVAS_AREA`,
  16,777,216px, matching PDF.js's own `maxCanvasPixels` default) and a
  4096px-per-side maximum (`MAX_CANVAS_DIM`), which win unconditionally: at high
  zoom on a large page the effective scale can fall below the display's
  `devicePixelRatio`. (This entry originally claimed the render was *never* below
  the display ratio, which was not accurate even at the time; the wording was
  corrected later, see #29.) Previously the backing store was sized
  close to CSS pixels, which read soft on fractional-scale displays (Windows
  125%/150%) and on platforms that under-report DPI. The viewer also now
  re-renders visible pages when `devicePixelRatio` changes mid-session, such as
  when a window is dragged between monitors with different scaling.
- **Page virtualization bounds memory on long documents.** Each page's canvas
  backing store is released (dimensions zeroed, text and form layers cleared)
  once it scrolls more than 600px out of the viewport, and is re-rendered when
  it scrolls back into range, instead of every page a session had ever
  displayed keeping its full-resolution canvas allocated indefinitely.
- The in-app **"Set as default PDF viewer"** action now deep-links straight to
  Folio's page in *Settings > Default apps* (via a `RegisteredApplications`
  Capabilities entry written by the installer, `src-tauri/installer.nsh`), so you
  no longer have to type ".pdf" to find the association. Takes effect on a fresh
  install.

## [0.2.0] - 2026-07-14

### Added

- **Default PDF viewer**: a `.pdf` file association (`bundle.fileAssociations`)
  so the OS can open PDFs with Folio. Double-clicking a PDF opens it in Folio,
  whether Folio is closed (launched with the file path via argv) or already
  running (the file is routed to the existing window through single-instance).
  Adds a "Make Folio your default PDF viewer" action on the start screen that
  opens the OS Default apps settings, plus the `take_launch_file` and
  `open_default_apps_settings` commands. Windows and Linux use the launch argv;
  the macOS `Opened`-event path is wired but untested. See docs/testing.md.
- **Editing toolkit (v0.4, phase 1)**: add **text boxes** (a typewriter tool with
  a font / size / bold / color inspector) and place **images** (PNG/JPEG) on a
  page, drag/resize both, and bake them into a saved copy (`stampEdits` via
  pdf-lib `drawText`/`drawImage`). Additive only: existing PDF text is not
  modified. New `src/features/editing` module and toolbar buttons. See
  docs/editing-and-ocr.md.
- **OCR (v0.4)**: recognize text in scanned pages with **tesseract.js** (English),
  run fully offline and under the app CSP (worker + wasm core + model self-hosted
  under `public/tesseract/`, populated by `scripts/setup-ocr-assets.mjs`, no CDN).
  Recognized text is selectable on screen, feeds in-app search (find falls back to
  OCR text on image-only pages), and is baked into a saved copy as an invisible,
  searchable text layer. New `renderPageToImage` engine method and
  `src/features/ocr` module (lazy-loaded so tesseract.js stays out of the initial
  bundle). See docs/editing-and-ocr.md.

## [0.1.0] - 2026-07-14

### Added

- Windows distribution: an **EV-signed NSIS installer** (OK Studio Inc. cert on a
  SafeNet eToken) via `scripts/sign-windows.ps1` wired through
  `bundle.windows.signCommand`, plus per-release CycloneDX SBOMs (npm + cargo)
  and a dependency lockfile. See docs/releasing.md.
- **Auto-update**: an in-app updater (`tauri-plugin-updater`) that checks GitHub
  Releases on launch and installs minisign-verified updates; per-user install so
  updates apply without a UAC prompt. `scripts/generate-latest.mjs` emits the
  update manifest.
- **Open PDFs in Folio from the browser**: a Chrome extension
  (`extensions/chrome`) that renders PDFs in Folio's in-browser viewer or hands
  them off to the desktop app via a new `folio://` deep link. Adds the deep-link,
  single-instance, updater, and process plugins and a URL-validated `fetch_pdf`
  command.
- Test suites: a Vitest unit suite (49 tests across stores, the command
  registry, the plugin host, keyboard shortcuts, and signing) and a Playwright
  end-to-end smoke suite (open, render, fill a form field, and digitally sign),
  plus a CI e2e job. See docs/testing.md.
- Cryptographic digital signatures (v0.3, phase 2):
  - Sign a document with a real PKCS#7 detached signature (via @signpdf and
    node-forge) that PDF readers, including Acrobat, recognize.
  - Signing identities: import a `.p12` / `.pfx`, or create a self-signed
    certificate in-app. Stored passphrase-protected; the passphrase is never
    saved.
  - Opened signed PDFs list each signature with signer, signing time, and a
    post-signing tamper check in the Signatures panel.
  - New `sign.digitallySign` command, a toolbar shield button, and a Node
    globals shim (`Buffer`/`process`) for the WebView. Certificate-chain trust
    validation and a Rust/keychain backend remain planned.
- Forms and signing (v0.3, phase 1):
  - Fill interactive AcroForm fields (text, checkbox, radio, dropdown) rendered
    over each page via the PDF.js annotation layer.
  - Ink / visual signatures: create by drawing, typing, or uploading an image,
    then place, drag, and resize on the page. Stored per document.
  - Save a copy with form values written (PDF.js `saveDocument`) and signatures
    stamped in (pdf-lib), via a native save dialog or browser download
    (`Ctrl/Cmd + S`). Writing goes through the Rust `write_document` command
    (see Changed).
  - Certificate-based digital signatures remain planned (phase 2).
- Initial project foundation (v0.1 scaffold):
  - Tauri 2 desktop shell with a React 18 + TypeScript frontend (Vite).
  - `PdfEngine` abstraction with a PDF.js implementation (rendering, text layer,
    outline, metadata, and text search).
  - Continuous, lazily-rendered page viewer with zoom, fit-width, and fit-page.
  - Thumbnail strip, document outline, and find-in-document.
  - Command registry driving all user actions and keyboard shortcuts.
  - Plugin host and SDK (commands, toolbar items, sidebar panels, tools), plus a
    built-in Word Count plugin.
  - Text highlighting with per-document persistence and an annotations panel.
  - Theming with light / dark / system and page reading modes (night, sepia,
    high-contrast).
  - Accessibility foundation: text layer, keyboard control, ARIA landmarks,
    skip link, and live-region announcements.
  - Provider-agnostic AI layer (Claude, opt-in) with MCP client/server stubs.
  - Documentation set, CI, and community-health files.

### Changed

- PDF writes moved to a Rust `write_document` command; the frontend no longer
  uses the fs plugin's `writeFile`, and the broad `fs:allow-write-file`
  (`$HOME/**`) capability was removed. Save-anywhere still works via the
  dialog-chosen path.
- Bumped Vite 5 to 7 and Vitest 2 to 4 (clears the vite/vitest/esbuild dev-only
  advisories).

### Security

- Added a strict Tauri Content Security Policy (`app.security.csp`), replacing
  the previous unset policy.
- Pinned GitHub Actions to commit SHAs with `persist-credentials: false`; added
  a security-scan CI workflow, pre-commit hooks (gitleaks + pinact), and a
  cargo-deny policy.

[Unreleased]: https://github.com/owenpkent/folio/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/owenpkent/folio/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/owenpkent/folio/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/owenpkent/folio/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/owenpkent/folio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/owenpkent/folio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/owenpkent/folio/releases/tag/v0.1.0
