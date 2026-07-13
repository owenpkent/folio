# Developing the Folio VS Code extension

## Architecture

VS Code registers a [custom editor](https://code.visualstudio.com/api/extension-guides/custom-editors)
for `*.pdf`. The extension host reads the file and hands a webview a URL to it;
the webview mounts Folio's React app and loads the bytes.

Folio was already built to run in a plain browser (its native calls are guarded
by `isTauri()`), and a VS Code webview is a browser context, so the app runs here
with its browser fallbacks. Only two things are webview-specific:

- **PDF.js worker.** The desktop build resolves the worker via Vite's `?url`
  import, which esbuild does not understand. [`build.mjs`](build.mjs) swaps any
  `*?url` import for a lookup into a global the extension injects with the real
  webview URI (`__FOLIO_ASSETS__`).
- **Theme.** [`src/webview/app.tsx`](src/webview/app.tsx) maps VS Code's
  `vscode-dark` / `vscode-light` body class onto Folio's `data-theme`, and
  follows theme switches live.

No Folio source is forked: the extension imports `@/App` and drives it through
the same `loadSource()` the desktop app uses.

```
extensions/vscode/
├─ src/
│  ├─ extension.ts        custom-editor provider + CSP'd webview HTML
│  └─ webview/app.tsx     mounts Folio's <App/>, bridges theme, loads the PDF
├─ build.mjs              esbuild: host (CJS) + app (IIFE) + worker copy
├─ media/                 icon + Marketplace screenshot
└─ package.json           contributes the folio.pdfViewer custom editor
```

## Build

The build resolves esbuild, React, PDF.js, and Folio's own `src/` from the repo's
existing `node_modules` (it walks up), so you do **not** need a separate install
just to build.

```bash
# from extensions/vscode/
node build.mjs            # one-off build → out/
node build.mjs --watch    # rebuild on change
```

## Run

- Open this folder in VS Code and press **F5** (uses
  [.vscode/launch.json](.vscode/launch.json)), then open any PDF, or
- From a terminal:
  ```bash
  code --extensionDevelopmentPath="$(pwd)" path/to/file.pdf
  ```

For editor IntelliSense (types), optionally `npm install` here to pull
`@types/vscode`; it is not required for building or running.

## Regenerate the Marketplace assets

- **Icon** ([media/icon.png](media/icon.png)) — rasterized from
  [`src/assets/folio-logo.svg`](../../src/assets/folio-logo.svg).
- **Screenshot** ([media/screenshot.png](media/screenshot.png)) — the built
  `out/app.js` bundle rendered against a sample PDF in a headless browser
  (dark theme), captured at 1440×940.

## Security fuzzing

Two harnesses in [`fuzz/`](fuzz/) exercise the untrusted-input paths (a PDF's
filename reaching the webview HTML, and a filename reaching the LibreOffice
subprocess):

```bash
# Webview HTML escaping — drives adversarial filenames through escapeHtml and
# parses the result with jsdom, asserting no attribute breakout / script / handler
# injection; also checks the CSP nonce is CSPRNG hex with no collisions.
../../node_modules/.bin/esbuild fuzz/fuzz-html.mjs --bundle --platform=node \
  --packages=external --outfile=fuzz/_fuzz-html.cjs && node fuzz/_fuzz-html.cjs

# to_pdf.py command injection — creates real files named as shell payloads and
# asserts each lands as a single argv element with no shell (run from ATDev venv).
python fuzz/fuzz-to-pdf.py
```

Both report `ALL PASS` on the current code (60k+ HTML cases, 5k+ injection names).

## Distribute

See [DISTRIBUTING.md](DISTRIBUTING.md).
