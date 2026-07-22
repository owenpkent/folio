# Testing

Folio is tested at two layers:

- **Unit tests (Vitest)** cover the logic layer: stores, the command registry,
  the plugin host, keyboard-shortcut dispatch, and the signing helpers.
- **End-to-end tests (Playwright)** drive the running app in a real browser:
  open a PDF, render it, fill a form field, and cryptographically sign it.

## Running tests

```bash
npm run test           # unit tests (Vitest), single run
npm run test:watch     # unit tests in watch mode
npm run test:coverage  # unit tests with a V8 coverage report
npm run test:e2e       # end-to-end tests (Playwright)
```

The first e2e run needs the browser binary:

```bash
npx playwright install chromium
```

## Unit tests (Vitest)

Test files live next to the code they cover, named `*.test.ts` (or `.test.tsx`
for component tests), and run under jsdom. Suites that exercise the Node-oriented
signing stack opt into a Node environment with a file-level pragma:

```ts
// @vitest-environment node
```

Because the stores are module singletons, each suite resets state in
`beforeEach` (via the store's own `reset()` or `setState`) and clears
`localStorage` where persistence is involved, so tests stay independent.

What is covered today:

- **Stores**: `documentStore`, `viewerStore`, `themeStore`, the annotations,
  signatures, and signing stores, the plugin `contributionStore`, and the
  `toastStore` (persistence, zoom/page clamping, reset, base64 round-trip,
  auto-dismiss with fake timers).
- **Command registry**: register/execute/dispose, `when` guards, context args,
  subscriptions, and the default command set (registration and document gating).
- **Plugin host**: activate/deactivate, contribution cleanup on teardown, and
  document-open events.
- **Keyboard shortcuts**: chord dispatch, the "don't hijack typing in inputs"
  guard, and `when()` gating (via `renderHook`).
- **Signing**: an end-to-end helper test that generates a self-signed
  certificate, signs a pdf-lib document, and re-detects the signature; plus
  `detectSignatures` on unsigned input.
- **Components**: `ToastHost` and `EmptyState` render tests.

Coverage: the core logic modules (stores, registry, `cert`, `verify`) sit around
90 to 100 percent. Overall line coverage is lower because the view components and
PDF rendering are exercised by the end-to-end suite rather than in unit tests.

### Adding a unit test

Create `thing.test.ts` beside `thing.ts`, import from `vitest`, and reset any
shared store state in `beforeEach`. Keep tests deterministic and fast.

## End-to-end tests (Playwright)

The e2e suite (`e2e/`) runs against the **browser build** served by the Vite dev
server, not the packaged desktop app. In the browser, `isTauri()` is false, so
opening a document uses a file input and saving triggers a download, which is
exactly what the tests drive. `playwright.config.ts` starts `npm run dev` and
points the tests at `http://localhost:1420`.

`e2e/global-setup.ts` generates the fixtures with pdf-lib and writes them to
`e2e/fixtures/` (gitignored, regenerated each run). Nothing binary is committed.
There are two: `form.pdf`, a two-page PDF with an empty fillable text field, and
`filled-form.pdf`, a single page whose only content is three text fields that
already hold values. The latter is deliberately otherwise blank, so any ink on
the rendered canvas is a form widget that should have been left to the
annotation layer, which is what makes the doubled-text assertion below possible.

There are four specs.

**`e2e/smoke.spec.ts`** — the core document flows:

1. The empty state renders on launch.
2. Toggling dark mode sets `data-theme="dark"`.
3. Opening a PDF renders its pages and updates the page count.
4. A filled form's values are not painted into the page canvas (they belong to
   the DOM inputs alone; both copies at once is the doubled-text bug).
5. Form fields expose the label the PDF gave them (`/TU`, falling back to `/T`).
6. `Page Up` / `Page Down` scroll the document, including after focus has left it
   for the toolbar.
7. Closing the find bar hands focus back to the document, so the scroll keys
   keep working.
8. Filling an AcroForm field and digitally signing produces a downloaded
   `(signed)` copy.

**`e2e/accessibility.spec.ts`** — platform settings, which Section 508 503.2
requires and WCAG does not: UI text scales with the user's root font size, and
under forced colors (Windows High Contrast) the design tokens resolve to system
colors, toggled buttons stay distinguishable from untoggled ones, and the page
canvas opts out of recoloring.

**`e2e/annotations.spec.ts`** — that a saved copy really contains what you
marked up: a highlight round-trips as a real `/Highlight` annotation carrying its
text in `/Contents`, annotated pages declare `Tabs = S` while untouched pages do
not, and the document's original form field survives alongside the new
annotation. It also writes its export to `test-results/exports/`, which is what
the CI job feeds to veraPDF (see [Measuring PDF/UA](#measuring-pdfua)).

**`e2e/toolbar.spec.ts`** — responsive toolbar behavior: all controls stay
on-screen on a narrow window, tools that no longer fit collapse into a
reachable **More** menu when very narrow, and nothing collapses on a wide
window.

**`e2e/mobile.spec.ts`** — the narrow-viewport ("mobile") mode at a phone size
(390×844): the sidebar starts closed and opens as an overlay drawer rather than
squeezing the viewer, a tap on the backdrop or an **Escape** dismisses it
(peeling the topmost layer first, before find closes), the toolbar never
clips and everything folded out of the bar (About, theme, fit modes, zoom)
stays reachable in the **More** menu, and picking a thumbnail navigates and
closes the drawer.

### Tests that pin silent failures

Most of the suite guards behaviour that fails *quietly*, which is why these tests
are worth more than their line count and why you should be careful editing them:

- **A wrong `annotationMode` renders every field twice** and looks like a
  rendering quirk. This is the cautionary one: the plausible-looking
  `ENABLE_STORAGE` leaves the duplicate text exactly where it was, and **only a
  canvas-pixel assertion catches it** — every DOM-level check passes.
- **The scroll keys simply do nothing** when focus is not where they need it.
  There is no error, just a dead key.
- **Form labels**: the test asserts through `getByRole(..., { name })`, the real
  accessible-name computation, not the attribute. An attribute check would pass
  while a screen reader still announced an unlabeled edit box.
- **Annotation export**: the test parses the saved copy with pdf-lib rather than
  searching the bytes. pdf-lib writes object streams, so a compressed annotation
  dict is invisible to a text search and the assertions would happily pass
  against a file containing nothing.
- **Forced colors** are emulated with `page.emulateMedia`, not the `forcedColors`
  fixture — the fixture does not take effect here, the media query never
  matches, and every assertion passes vacuously against unstyled defaults.

The rule these share: **when you touch one of these, first check it actually
fails against the unfixed code.** A test that cannot fail is worse than no test,
because it reads like a guarantee.

### Measuring PDF/UA

The `e2e` CI job runs veraPDF (`--flavour ua1`, pinned by digest) over the
exports the annotation spec produces, and uploads the result as the
`pdfua-report` artifact.

It is **informational and non-blocking on purpose**: PDF/UA export is a known
"Does Not Support" (see [508-conformance.md](508-conformance.md)), so it reports
failures today. The point is that the gap is a tracked number rather than a
guess, and that a regression in the parts we *do* satisfy shows up. Note veraPDF
implements only the machine-checkable subset of PDF/UA — a clean run would still
say nothing about reading order, which is human-judged.

Useful flags:

```bash
npm run test:e2e -- --headed    # watch the browser
npm run test:e2e -- --debug     # step through with the inspector
npx playwright show-report      # open the last HTML report
```

## Manual testing (desktop and browser integrations)

Signing, the updater, the `folio://` deep link, and the Chrome extension can't
run in the automated suite; verify them by hand.

### Run the app

```bash
npm run tauri dev     # native desktop app, hot reload
npm run dev           # browser-only viewer (no native shell)
```

Click through: open (Ctrl+O), scroll/zoom, search (Ctrl+F), highlight
(Ctrl+Shift+H), fill a form, digitally sign, save (Ctrl+S) or save a copy
(Ctrl+Shift+S), toggle dark mode (Ctrl+Shift+L).

### Signed installer

From a non-elevated shell with the eToken plugged in and the updater key env set
(see [releasing.md](releasing.md)):

```powershell
npx tauri build --bundles nsis
Get-AuthenticodeSignature .\src-tauri\target\release\bundle\nsis\Folio_0.1.0_x64-setup.exe | Format-List Status, SignerCertificate
```

Status should be `Valid` with signer `CN=OK Studio Inc.`. Run the installer and
confirm it installs to `%LOCALAPPDATA%\Folio` and launches.

### folio:// deep link

Install the app first so the scheme is registered, then:

```powershell
Start-Process "folio://open?url=https://<any-public>.pdf"   # opens in Folio
Start-Process "folio://open?url=http://localhost/x.pdf"     # refused (SSRF guard)
```

### Default PDF viewer (file association)

Install the app first (the `.pdf` association is written by the installer, not by
`tauri dev`), then:

- **Appears as a handler:** right-click any `.pdf` -> *Open with* -> *Choose
  another app*. **Folio** should be listed.
- **Cold start:** with Folio closed, double-click a `.pdf` (or
  `Start-Process folio-set-default.pdf`). Folio launches **and renders that
  document**, not the empty state.
- **Already running:** with Folio open, double-click a *different* `.pdf`. The
  existing window focuses and loads the new file (no second window).
- **In-app action:** on the empty state, click *Make Folio your default PDF
  viewer*. Windows *Settings -> Default apps* opens so you can pick Folio for
  `.pdf`.

### Editing (text boxes + images)

Works in both the browser build (`npm run dev`) and the desktop app.

- **Text:** toolbar *Add text box* (the `T`), type into it, then use the inline
  inspector (font, size, **B**, color) and drag the grip / corner to move and
  resize. Click empty space or press Escape to deselect.
- **Image:** toolbar *Add image*, pick a PNG/JPEG, drag/resize it.
- **Round-trip:** Save a copy (Ctrl+S), reopen in Folio **and** a third-party
  reader; the text and image should sit where you placed them.

### Editing text in place

Works in both the browser build (`npm run dev`) and the desktop app.

- Toolbar *Edit text* (the pencil), then click a run of text on the page: an
  inline editor opens, prefilled with that run and styled to match it.
- Type a replacement, then **Enter** or click away to commit; **Escape** cancels
  and leaves the original text alone.
- **Ctrl/Cmd + Z** undoes the most recent commit (repeatable, up to 10 edits).
- Click text you expect to be blocked (rotated, or part of an embedded object)
  and confirm a toast explains it instead of the editor opening.
- **Round-trip:** commit an edit, Save a copy (Ctrl+S), reopen in Folio **and**
  a third-party reader; the new text should read correctly with no trace of the
  original run underneath it.

### OCR (scanned pages)

Needs the self-hosted assets (`npm run setup:ocr`, or just run the app once).
Use an image-only / scanned PDF (no embedded text).

- Toolbar *Recognize text (OCR)* -> a progress modal counts pages (Cancel works).
- After it finishes: **select** text on the page and copy it; **find** (Ctrl+F)
  a word from the scan and confirm it hits.
- Save a copy, open it in another reader, and confirm the text is now
  selectable/searchable there (an invisible layer over the image).
- **Offline/CSP:** with the desktop app, disconnect the network after the first
  run and confirm OCR still works (assets are served from `/tesseract/`, no CDN).

### Chrome extension

```bash
node extensions/chrome/build.mjs
```

Load `extensions/chrome` as an unpacked extension at `chrome://extensions`
(Developer mode on). Then:

- Navigate to a PDF URL: it should render in Folio's in-browser viewer.
- Right-click a PDF link, or click the toolbar icon: **Open in Folio (desktop)**
  should launch the app.

See [extensions/chrome/README.md](../extensions/chrome/README.md) for full notes.

### CSP / rendering

Open an image-heavy (ideally JPEG2000) PDF in the desktop build. If it renders,
the CSP's worker/wasm directives are correct.

### Auto-updater

Requires two versions: install one, publish a higher version to GitHub Releases
with a `latest.json` (see [releasing.md](releasing.md)), relaunch, and confirm
the update prompt. It can't be exercised from a single local build.

## Continuous integration

`.github/workflows/ci.yml` runs three jobs on every push and pull request:

- **quality**: lint, typecheck, and unit tests on Ubuntu across Node 20 and 22.
- **e2e**: installs Chromium and runs the Playwright suite, then measures the
  exported PDFs against PDF/UA-1 with veraPDF. Uploads both the Playwright report
  and the `pdfua-report` artifact. The veraPDF step is non-blocking; see
  [Measuring PDF/UA](#measuring-pdfua).
- **build**: a `--no-bundle` Tauri compile across Ubuntu, macOS, and Windows
  (bundling + signing need the release host's EV cert and updater key, so CI
  compiles only).

## Not yet covered (planned)

- axe-core accessibility scans wired into the e2e suite (see
  [accessibility.md](accessibility.md)).
- Component tests for the viewer, toolbar, sidebar, and modals.
- Engine-level rendering and text-extraction tests against sample PDFs.
- More e2e flows: search, thumbnails, and outline navigation.
- Screen-reader verification is still manual (NVDA on Windows, VoiceOver on
  macOS). The e2e suite asserts accessible names and roles, which is not the
  same as confirming a document reads well.
