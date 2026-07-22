# Changelog

All notable changes to Folio are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  drawer over the document (it starts closed, a tap on the dimmed area
  dismisses it, and picking a thumbnail or outline entry navigates and closes
  it), and the toolbar folds the filename, the theme controls, About, and the
  secondary view tools (fit width/page, hand tool, auto-scroll) into the
  **More** menu as labeled rows, so every control stays reachable. At 480px
  and below, zoom in/out and the zoom readout fold as well. Coarse (touch)
  pointers get 40px hit targets. Toolbar icon buttons no longer flex-shrink
  when space runs out; squeezed buttons also distorted the width measurement
  that decides what collapses into the menu. Breakpoints live in
  `src/theme/breakpoints.ts`, and `e2e/mobile.spec.ts` pins the drawer and
  no-clip behavior at a phone viewport.

### Fixed

- **Saves are atomic.** `write_document` now writes to a randomly named temp
  file in the destination directory and renames it over the target, so a crash
  or full disk mid-save can no longer leave a truncated PDF. This matters now
  that Save writes back to the opened document rather than only to new copies.
- **"Make Folio your default PDF viewer" reliably opens Windows Settings.**
  The `ms-settings:` deep link is now launched through ShellExecute (a hidden
  `cmd /C start`) instead of `explorer.exe`, which dropped the URI's query on
  some Windows builds and opened the default web browser instead.

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
  4096px-per-side maximum (`MAX_CANVAS_DIM`), and never rendered below the
  display's actual `devicePixelRatio`. Previously the backing store was sized
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

[Unreleased]: https://github.com/owenpkent/folio/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/owenpkent/folio/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/owenpkent/folio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/owenpkent/folio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/owenpkent/folio/releases/tag/v0.1.0
