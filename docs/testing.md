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
npm run test:fuzz      # property tests at a high iteration count
npm run test:e2e       # end-to-end tests (Playwright), against the dev server
npm run test:e2e:preview  # the same suite against a production build
```

The first e2e run needs the browser binary:

```bash
npx playwright install chromium
```

Run it again after any `@playwright/test` upgrade. Playwright pins each release
to its own browser build, so a version bump leaves the old binary behind and
**every spec fails at 0ms** with `browserType.launch: Executable doesn't exist`.
That reads like a catastrophic regression and is nothing of the sort.

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

## Property and fuzz tests (fast-check)

Files named `*.fuzz.test.ts` use [fast-check](https://fast-check.dev) through
`@fast-check/vitest`. They run as part of `npm test` like any other spec, so the
normal suite stays a gate rather than a lottery; `npm run test:fuzz` re-runs just
those files at a much higher iteration count.

They exist for the code that reads bytes straight out of a PDF. Every offset such
a parser reports is attacker-influenced, and most of them are later used as slice
bounds or array indices, so the invariants worth asserting are things an
example-based test tends not to reach: the function is total, its results stay in
bounds, and it cannot be made to do unbounded work.

Current targets:

| File | What it pins |
| --- | --- |
| `features/signing/verify.fuzz.test.ts` | `detectSignatures`, the only PDF parser a hostile document reaches with no user action. A signature may only be reported as covering the whole document when the range it names ends inside the file, and the caps that stop a hostile document stalling the UI thread hold: the scan gives up after a fixed number of candidate `/ByteRange` sites and a fixed total decoding budget. Both are pinned through what the cap causes (a signature parked behind the decoys goes unreported; the scan stops short of the result cap) rather than through a wall clock, which on a document small enough to build in a test measures nothing. |
| `features/textedit/contentStream.fuzz.test.ts` | The content-stream tokenizer and the splice primitives: reported runs are always in range and spliceable, an operator splice never glues two tokens together, and a hostile form resolver cannot cause unbounded descent. |

### Seeds and reproducing a failure

`src/test/setup.ts` reads two environment variables:

- `FC_NUM_RUNS`: iterations per property (default 100; `npm run test:fuzz`
  raises it to 20,000).
- `FC_SEED`: pins the generator so a run is byte-for-byte reproducible.

A malformed value for either is an error rather than a silent fall back to the
default. `FC_NUM_RUNS=20k` is `NaN`, and `NaN` runs is zero runs, which every
property in the suite passes without executing a single case.

A failure prints both a seed and a shrink path, and names the smallest input it
could find. Replay it exactly by putting them on the property:

```ts
test.prop([arb], { seed: -1018431547, path: '0:0:0:1', endOnFailure: true })(...)
```

Once fixed, keep the minimal input as an entry in the property's `examples`
array so it is checked on every run from then on, seed or no seed.

### Adding a fuzz test

Write generators that produce *structurally plausible* input. A parser keyed on a
literal like `/ByteRange` will essentially never see it in random bytes, so an
unstructured `fc.uint8Array()` would spend every iteration on the not-found path
and prove nothing. Build the shape and fuzz the parts an attacker controls: the
offsets, the lengths, the spacing, what follows the end.

## End-to-end tests (Playwright)

The e2e suite (`e2e/`) runs against the **browser build** served by the Vite dev
server, not the packaged desktop app. In the browser, `isTauri()` is false, so
opening a document uses a file input and saving triggers a download, which is
exactly what the tests drive. `playwright.config.ts` starts `npm run dev` and
points the tests at `http://localhost:1420`.

### The same suite against a production build

`npm run test:e2e:preview` runs every spec again through
`playwright.preview.config.ts`, which builds the app and serves `dist/` with
`vite preview` on port 4173. CI runs both.

The two targets are not interchangeable. The dev server ships each module
roughly as authored; the build puts everything through rolldown and its
minifier, so **anything that depends on how modules are bundled is exercised
only by the second run**. That gap once shipped a real bug: the Vite 8 bump
([#62](https://github.com/owenpkent/folio/pull/62)) broke digital signing
outright, because rolldown and esbuild disagree about what a default import of a
CommonJS module means (see the `__esModule` guard in
`src/test/buildToolchain.test.ts`). Nothing else could see it -- `tsc` reads the
`.d.ts`, and Vitest runs in Node, whose interop matches esbuild -- and the
dev-server run caught it only by coincidence, because the dep optimizer happened
to make the same choice as the bundler.

Two details are deliberate. The build is part of the server command, and the
preview run never reuses a running server: a stale `dist/` would serve last
week's bytes and pass. And it writes to `test-results-preview/` and
`playwright-report-preview/`, because Playwright wipes its output directory on
start and sharing one would delete the exports CI feeds to veraPDF.

`e2e/global-setup.ts` generates the fixtures with pdf-lib and writes them to
`e2e/fixtures/` (gitignored, regenerated each run). Nothing binary is committed.
There are four: `form.pdf`, a two-page PDF with an empty fillable text field, a
checkbox, and a radio group; `filled-form.pdf`, a single page whose only content
is three text fields that already hold values; `addresses.pdf`, a page carrying
an email address, a web address, and a `/Link` annotation whose declared target
is deliberately nothing like the words printed over it; and `pages.pdf`, four
portrait pages each printing the position it started in. The second is
deliberately otherwise blank, so any ink on the rendered canvas is a form widget
that should have been left to the annotation layer, which is what makes the
doubled-text assertion below possible. The fourth exists because after a reorder
every page still renders, and only the words on them say whether the right one
moved.

There are eleven specs.

**`e2e/smoke.spec.ts`** covers the core document flows:

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
8. A real AcroForm checkbox widget renders, is keyboard reachable (focus and
   `Space` toggle it), and also toggles on a pointer click.
9. That checkbox still toggles via a (forced) pointer click while the Edit
   text tool is armed, guarding that its full-page click-catcher redirects the
   click to the widget underneath rather than swallowing it.
10. A real radio group renders two mutually exclusive options.
11. Filling an AcroForm field and digitally signing produces a downloaded
    `(signed)` copy.

**`e2e/accessibility.spec.ts`** covers platform settings, which Section 508 503.2
requires and WCAG does not: UI text scales with the user's root font size, and
under forced colors (Windows High Contrast) the design tokens resolve to system
colors, toggled buttons stay distinguishable from untoggled ones, and the page
canvas opts out of recoloring.

**`e2e/annotations.spec.ts`** confirms that a saved copy really contains what you
marked up: a highlight round-trips as a real `/Highlight` annotation carrying its
text in `/Contents`, annotated pages declare `Tabs = S` while untouched pages do
not, and the document's original form field survives alongside the new
annotation. It also writes its export to `test-results/exports/`, which is what
the CI job feeds to veraPDF (see [Measuring PDF/UA](#measuring-pdfua)).

**`e2e/toolbar.spec.ts`** covers responsive toolbar behavior: all controls stay
on-screen on a narrow window, tools that no longer fit collapse into a
reachable **More** menu when very narrow, and nothing collapses on a wide
window.

**`e2e/mobile.spec.ts`** covers the narrow-viewport ("mobile") mode at a phone size
(390×844): the sidebar starts closed and opens as an overlay drawer rather than
squeezing the viewer, a tap on the backdrop or an **Escape** dismisses it
(peeling the topmost layer first, before find closes), the toolbar never
clips and everything folded out of the bar (About, theme, fit modes, zoom)
stays reachable in the **More** menu, and picking a thumbnail navigates and
closes the drawer.

**`e2e/placement.spec.ts`** -- click-to-place and the text-box drag: a text box
lands top-left at the click (not centered on the page) and takes typing straight
away, the banner's focused **Place in the middle** button places one without a
pointer at all (the keyboard path, WCAG 2.1.1), **Escape** or a click off a page
(the margin, the toolbar) cancels an armed placement without placing anything, a
box is dragged from anywhere on it while a press that does not travel still edits
it,
and a typed signature lands centered on the click and is offered back, prefilled,
the next time the dialog opens.

**`e2e/print.spec.ts`** -- that print reaches the dialog with a real, fully baked
raster: one decoded image per page, the `folio-printing` class that reveals them,
and a filled field measurably darkening the page-1 raster compared with the same
document printed empty. This spec exists because the unit tests cannot do its
job: they mock `pdfjs-dist`, so they see nothing about which PDF.js build is
imported or whether its worker is configured. Print shipped green through them
while failing on the first document in the real app. Both tests stub
`window.print` -- the assertion is about what reaches the dialog, and a real
dialog is a modal that would hang the run.

**`e2e/keyboard-manipulation.spec.ts`** -- the keyboard path for direct
manipulation (WCAG 2.1.1), which dragging and the corner handle were previously
the only route to: a placed text box moves with the arrow keys and ten times as
far with **Shift** held, `+`/`-` resize it and **Delete** removes it, a placed
signature does the same with its aspect ratio locked, and two guards that matter
more than the happy path -- arrows *inside* a text box move the caret rather than
the box, and a nudge key moves the item **without** also scrolling the document
out from under it.

**`e2e/links.spec.ts`**: copying an email or web address from the right-click
menu, asserted against the real clipboard rather than the announcement alone.
The one that matters most is the `/Link` annotation case: the menu has to show
and copy the target the document declared, not the "Click here for details"
printed over it. It aims its right-clicks through PDF user-space geometry rather
than at a text-layer span, so it measures the hit test rather than how PDF.js
happens to lay its spans out. It also covers the hover affordance, including
that `Escape` dismisses the hint without the pointer moving.

**`e2e/pages.spec.ts`** -- page operations end to end: deleting a selected page
and putting it back with **Ctrl+Z**, reordering by drag and by **Alt+↓** (with
the live-region announcement), rotating a page (asserted through the layout box
turning landscape, which is the part that silently did not happen until page
geometry was re-measured on a document swap), the organizer opening over the
document, and the selection checkboxes being operable from the keyboard. It also
pins the refusal to delete every page, since a zero-page PDF is not a PDF.

**`e2e/browser-extension.spec.ts`** -- the contract the Chrome extension depends
on, exercised through the viewer rather than through the extension (branded
Chrome will not side-load one from the command line). It renders a PDF named by
`#file=`, **keeps a query string intact** rather than truncating at the first
`&`, refuses schemes it will not fetch, and offers **Download original** only for
a document that came from a URL.

> One trap, because it made the suite lie before it failed: a Playwright `goto`
> whose only difference from the current URL is the fragment is a *same-document*
> navigation. The app never remounts, so it never reads the fragment, and the
> test asserts against the previous document. The spec's `openWithFragment`
> helper forces a real load; do not inline it away.

### Tests that pin silent failures

Most of the suite guards behaviour that fails *quietly*, which is why these tests
are worth more than their line count and why you should be careful editing them:

- **A wrong `annotationMode` renders every field twice** and looks like a
  rendering quirk. This is the cautionary one: the plausible-looking
  `ENABLE_STORAGE` leaves the duplicate text exactly where it was, and **only a
  canvas-pixel assertion catches it**; every DOM-level check passes.
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
  fixture: the fixture does not take effect here, the media query never
  matches, and every assertion passes vacuously against unstyled defaults.
- **The document mutation lock releases on a failed commit**
  (`ImageEditLayer.test.tsx`). The assertion has to be that the commit *failed*
  (an error toast), not just that the lock ended up free: an idle lock is equally
  what a successful commit and a commit that never ran leave behind, so the
  earlier version of this test would have gone on passing if the fixture became
  loadable or the button stopped rendering. A companion test pins the
  screen-reader case — a keyboard delete refused while another feature holds the
  lock must not announce `Image deleted`.

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
implements only the machine-checkable subset of PDF/UA: a clean run would still
say nothing about reading order, which is human-judged.

Useful flags:

```bash
npm run test:e2e -- --headed    # watch the browser
npm run test:e2e -- --debug     # step through with the inspector
npx playwright show-report      # open the last HTML report
```

## Manual testing (desktop and browser integrations)

Signing, the updater, and the `folio://` deep link can't run in the automated
suite; verify them by hand.

The Chrome extension is **partly** automated, and it is worth knowing which part.
Its pure logic (redirect rules, settings, the package writer) is unit tested, the
viewer contract has [`e2e/browser-extension.spec.ts`](../e2e/browser-extension.spec.ts),
and CI builds the package and checks the manifest's permission surface. What no
automation covers is the extension actually installed in a browser: that the
redirect rules fire, that the options page saves, and that the toolbar button
tracks the tab. Branded Chrome has ignored `--load-extension` since Chrome 137,
so loading it must be done by hand: `chrome://extensions` → Developer mode →
**Load unpacked** → `extensions/chrome/build` (after `npm run build:chrome`).

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
Get-Item .\src-tauri\target\release\bundle\nsis\Folio_*_x64-setup.exe | Get-AuthenticodeSignature | Format-List Status, SignerCertificate
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
  another app*. **Folio** should be listed, under that name -- not under the
  file-type description ("Portable Document Format document"). This is the check
  that fails when the installer's `OpenWithProgids` /
  `Applications\folio.exe` registration is missing; see
  `src-tauri/installer.nsh`.
- **Application identity:**
  `(Get-ItemProperty "HKCU:\Software\Classes\PDF Document\Application").ApplicationName`
  should be `Folio`. This is the key that actually fixes the reported symptom
  (Folio showing up as "Portable Document Format document"); it has its own
  write in `src-tauri/installer.nsh`, separate from the `Applications\folio.exe`
  entry above.
- **Browser download, before changing the default:** right after a fresh
  install, with some other app still the `.pdf` default, download a PDF in
  Chrome and open the downloads-bubble dropdown (the chevron next to the file)
  -> *Open with*. **Folio** should be offered there, even though a plain click
  still opens whatever app *is* the default. This is the browser-download check
  that actually depends on this PR's keys. A stock Chrome profile opens PDFs in
  Chrome's own viewer instead of downloading them
  (`chrome://settings/content/pdfDocuments`), so switch that setting to
  "Download PDF files" first, or the file never reaches the downloads bubble.
- **Browser download, after changing the default:** with Folio set as the
  `.pdf` default, click the same downloaded file directly. It opens in Folio.
  This step exercises nothing Folio-specific -- Chrome just calls
  `ShellExecute`, so it passes or fails purely on the Windows default -- but it
  is the path users actually report on.
- **Cold start:** with Folio closed, double-click a `.pdf` (or
  `Start-Process folio-set-default.pdf`). Folio launches **and renders that
  document**, not the empty state.
- **Already running:** with Folio open, double-click a *different* `.pdf`. The
  existing window focuses and loads the new file (no second window).
- **In-app action:** on the empty state, click *Make Folio your default PDF
  viewer*. Windows *Settings -> Default apps* opens so you can pick Folio for
  `.pdf`.
- **Uninstall cleanup:** uninstall, then confirm the hooks' writes are gone.
  `HKCU:\Software\RegisteredApplications` has no `Folio` value;
  `HKCU:\Software\Folio\Capabilities` is gone; `OpenWithProgids` under
  `HKCU:\Software\Classes\.pdf` no longer lists `PDF Document`;
  `HKCU:\Software\Classes\Applications\folio.exe` is gone; and if you had
  picked Folio via *Open with -> Always*, so `...\FileExts\.pdf\UserChoice`
  pointed at it, that key is gone too (Windows asks again next time, instead
  of silently reusing the now-deleted ProgID). `.pdf`'s default value should
  point at a real ProgID, not a dangling `PDF Document`.

### Editing (text boxes, images, and check marks)

Works in both the browser build (`npm run dev`) and the desktop app.

- **Text:** *Edit -> Add text box*, click where the box should go, type into it,
  then use the inline inspector (font, size, **B**, color) and drag the box /
  corner to move and resize. Click empty space or press Escape to deselect.
  Escape while the placement banner is up cancels instead of placing, and its
  *Place in the middle* button (focused on open) is the no-pointer route.
- **Image:** *Edit -> Add image*, pick a PNG/JPEG, click to place it, then
  drag/resize it.
- **Check mark:** *Edit -> Add check mark*, then click a spot on the page to
  stamp it there. Check that clicking a *real* checkbox widget while the tool is
  armed ticks the widget instead of stamping a mark. Drag it to reposition, drag
  the corner to resize, or delete it, and switch it between check and cross in
  its inline inspector.
- **Keyboard, any placed item:** focus a text box, image, check mark, or
  signature with `Tab` (the Edit images tool focuses its own selection) and check
  the arrow keys move it, **Shift** + arrow moves further, `+`/`-` resize it, and
  **Delete** removes it. Two things to watch specifically: arrows typed *inside*
  a text box must move the caret, not the box, and a nudge must not scroll the
  document at the same time.
- **Edit images:** *Edit -> Edit images*, click an image already on the page,
  then drag it, resize it from the corner, *Replace image...* it with a
  differently shaped PNG/JPEG (it should letterbox into the old box, not
  stretch), or delete it.
- **Round-trip:** Save a copy (Ctrl+S), reopen in Folio **and** a third-party
  reader; the text, image, and check mark should sit where you placed them.

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

### Editing embedded images

Use a PDF with at least one image already on the page (not one placed with
Folio's own *Add image*).

- Toolbar *Edit images* (the corner-brackets icon), then click the image: a
  bordered box appears with a resize handle, a *Replace image…* button, and a
  delete button.
- Drag the box to move the image, and its corner to resize it; release the
  pointer and confirm the page updates in place.
- *Replace image…*, pick a different PNG/JPEG, and confirm it appears in the
  same spot at the same size.
- Delete the image and confirm it is gone from the page.
- If the document has a rotated image or one inside a template/letterhead,
  click it and confirm either a toast explains why it is not editable, or (for
  a rotated image) that only *Replace image…* and delete are offered.
- **Round-trip:** commit an edit, Save a copy (Ctrl+S), reopen in Folio **and**
  a third-party reader; the change should be there with no trace of the
  original image underneath it.

### OCR (scanned pages)

Needs the self-hosted assets (`npm run setup:ocr`, or just run the app once).
Use an image-only / scanned PDF (no embedded text).

- Toolbar *Recognize text (OCR)* -> a progress modal counts pages (Cancel works).
- After it finishes: **select** text on the page and copy it; **find** (Ctrl+F)
  a word from the scan and confirm it hits.
- Watch the **highlight**, not just the copied text, and drag across a long line
  at more than one zoom level. Each word's highlight should sit on the word and
  cover it top to bottom, and the last word on a line should be no further off
  than the first. Highlights that come out narrow, ride above the glyphs, or
  drift further right along a line mean the per-word horizontal scale in
  `OcrTextLayer` is not being applied (see
  [editing-and-ocr.md](editing-and-ocr.md#how-it-works)).
- Save a copy, open it in another reader, and confirm the text is now
  selectable/searchable there (an invisible layer over the image).
- **Offline/CSP:** with the desktop app, disconnect the network after the first
  run and confirm OCR still works (assets are served from `/tesseract/`, no CDN).

### One document change at a time

Worth a pass by hand, because the failure mode is silent and the interesting
cases are races. Start a long OCR run on a multi-page scan, then, while it runs:

- Confirm **Edit text** and **Edit images** still work. Recognition writes only
  its own sidecar, so these are deliberately *not* blocked.
- Confirm **Save**, **Print**, and **Digitally sign** are reachable but ask
  first: a dialog names how many pages have text so far and offers *Save anyway*
  / *Wait for recognition*. Take **Wait** and confirm nothing is written and no
  error is shown; take **Save anyway** on a second try and confirm the copy
  really is searchable for the recognized pages and image-only for the rest.
  `Escape` must count as Wait, never as Save.
- Confirm **Pages** operations, **Combine**, **Open**, and **Close** are disabled,
  each with a tooltip saying another document change is in progress, and that
  `Ctrl+O` / `Ctrl+W` report the refusal rather than doing nothing.

Then the reverse, which is the corruption case the lock exists for: select some
pages and start a rotate on a large document, and while it commits, **drop a
different PDF onto the window**. The drop must be refused with a toast, not
loaded. Before the lock, it loaded, and the page operation then remapped the old
document's highlights and signatures onto the new one's bytes.

Finally, with a screen reader on: select an image with the Edit images tool,
start a page operation, and press `Delete`. It must not say `Image deleted`.

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

While you have that two-version setup, the post-update resume is worth the same
pass, since only the packaged app can exercise it:

- Open a PDF **from disk**, scroll to a page past the first, take the update, and
  choose **Restart now**. The same document should come back at the same page.
- Take the update again from a build with **nothing open**, and confirm the
  restart comes back empty rather than reopening the document from the run
  before.
- Open a PDF **from the browser extension** (a `folio://` deep link) and take the
  update. There is no path on disk to reopen, so the restart comes back empty;
  it must not fail or reopen something else.
- Choose **Later** instead, then quit and relaunch by hand. Nothing should be
  reopened: the note is only written for a restart accepted there and then.
- Relaunch once more. Still nothing reopened: the note is consumed on the first
  launch after it is written, used or not.
- Move or delete the file between the restart being accepted and Folio coming
  back up. The failure should be one toast naming the problem, and the launch
  after that should be clean.

## Continuous integration

`.github/workflows/ci.yml` runs four jobs on every push and pull request:

- **quality**: lint, typecheck, and unit tests on Ubuntu across Node 22 and 24.
- **fuzz**: the property tests, seeded and capped at 500 iterations so the merge
  gate stays reproducible and quick. The same job runs unseeded at 20,000
  iterations on the nightly schedule, which is the only thing that trigger exists
  for; every other job opts out of it. See
  [Seeds and reproducing a failure](#seeds-and-reproducing-a-failure).
- **e2e**: installs Chromium and runs the Playwright suite twice, once against
  the dev server and once against a production build, then measures the exported
  PDFs against PDF/UA-1 with veraPDF. Uploads a Playwright report per run plus
  the `pdfua-report` artifact. The second run happens even when the first fails,
  because the pair is the diagnosis: dev green with preview red means bundling,
  both red means the app. The veraPDF step is non-blocking; see
  [Measuring PDF/UA](#measuring-pdfua).
- **build**: a `--no-bundle` Tauri compile across Ubuntu, macOS, and Windows
  (bundling + signing need the release host's EV cert and updater key, so CI
  compiles only).

## Not yet covered (planned)

- axe-core accessibility scans wired into the e2e suite (see
  [accessibility.md](accessibility.md)).
- Component tests for the viewer, toolbar, sidebar, and modals.
- Engine-level rendering and text-extraction tests against sample PDFs.
- More e2e flows: search, thumbnails, outline navigation, check-mark
  stamping, and image editing.
- Screen-reader verification is still manual (NVDA on Windows, VoiceOver on
  macOS). The e2e suite asserts accessible names and roles, which is not the
  same as confirming a document reads well.
