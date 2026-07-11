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

`e2e/global-setup.ts` generates the fixture, a two-page PDF with a fillable text
field, using pdf-lib and writes it to `e2e/fixtures/` (gitignored, regenerated
each run). Nothing binary is committed.

The smoke suite (`e2e/smoke.spec.ts`) covers:

1. The empty state renders on launch.
2. Toggling dark mode sets `data-theme="dark"`.
3. Opening a PDF renders its pages and updates the page count.
4. Filling an AcroForm field and digitally signing produces a downloaded
   `(signed)` copy.

Useful flags:

```bash
npm run test:e2e -- --headed    # watch the browser
npm run test:e2e -- --debug     # step through with the inspector
npx playwright show-report      # open the last HTML report
```

## Continuous integration

`.github/workflows/ci.yml` runs three jobs on every push and pull request:

- **quality**: lint, typecheck, and unit tests on Ubuntu across Node 20 and 22.
- **e2e**: installs Chromium and runs the Playwright suite, uploading the report.
- **build**: a debug Tauri build across Ubuntu, macOS, and Windows.

## Not yet covered (planned)

- axe-core accessibility scans wired into the e2e suite (see
  [accessibility.md](accessibility.md)).
- Component tests for the viewer, toolbar, sidebar, and modals.
- Engine-level rendering and text-extraction tests against sample PDFs.
- More e2e flows: annotations, search, thumbnails, and outline navigation.
