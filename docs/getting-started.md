# Getting Started with Folio

Folio is a desktop PDF viewer built with **Tauri 2** (Rust backend) and a **React 18 + TypeScript 5 + Vite 5** frontend, rendering with **PDF.js**. This guide gets you from a clean machine to a running dev build and a release bundle.

## Prerequisites

You need three things: Node, the Rust toolchain, and your platform's Tauri 2 system dependencies.

### Node.js

- **Node >= 20** is required. Development uses **v22**.
- Comes with **npm**, which is Folio's package manager. Do not substitute yarn or pnpm; the lockfile is `package-lock.json`.

Check:

```bash
node --version   # v20 or newer
npm --version
```

### Rust (stable)

Install the Rust toolchain via **rustup** (the Tauri backend in `src-tauri/` is compiled with the stable toolchain):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustc --version   # confirm a stable toolchain is installed
```

On Windows, install `rustup` from https://rustup.rs and select the MSVC toolchain (see below).

### Tauri 2 system dependencies

Tauri renders in a native WebView, which needs OS-level libraries. Install the set for your platform.

**Linux (Debian/Ubuntu):**

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  librsvg2-dev \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  patchelf
```

- `libwebkit2gtk-4.1-dev` provides the WebView (Tauri 2 uses the 4.1 series, not 4.0).
- `libsoup-3.0-dev` and `libjavascriptcoregtk-4.1-dev` are the HTTP and JavaScript-engine libraries the 4.1 WebView links against.
- `librsvg2-dev` is used for icon rasterization.
- `build-essential` provides the C toolchain and linker; `curl`, `wget`, and `file` are used by the Tauri build and bundling steps.
- `libssl-dev` is needed by Rust crates that link OpenSSL.
- `libgtk-3-dev` provides the GTK 3 toolkit the window shell uses.
- `libayatana-appindicator3-dev` supports the system tray / indicator.
- `patchelf` is required to assemble the Linux AppImage bundle.

On Fedora, the equivalents are `webkit2gtk4.1-devel`, `libsoup3-devel`, `javascriptcoregtk4.1-devel`, `openssl-devel`, `gtk3-devel`, `libappindicator-gtk3-devel`, `librsvg2-devel`, `patchelf`, and the `@development-tools` group. On Arch, use `webkit2gtk-4.1`, `libsoup3`, `base-devel`, `openssl`, `gtk3`, `libappindicator-gtk3`, `librsvg`, and `patchelf`.

**macOS:**

Install the **Xcode Command Line Tools** (provides the compiler, linker, and system SDKs; the WebView is the OS-provided WKWebView, so no extra runtime is needed):

```bash
xcode-select --install
```

**Windows:**

- Install the **Microsoft Visual C++ Build Tools** (MSVC) with the "Desktop development with C++" workload, which provides the compiler and linker the Rust MSVC toolchain uses.
- Install the **WebView2 Runtime**. It ships with current Windows 11 and recent Windows 10; if it is missing, install the Evergreen runtime from Microsoft.

For the authoritative, always-current list, see the Tauri 2 prerequisites page: https://v2.tauri.app/start/prerequisites/.

## Install

Clone the repository and install the JavaScript dependencies. Rust crates are fetched automatically on the first `tauri` command.

```bash
git clone https://github.com/<your-org>/folio.git
cd folio
npm install
```

`npm install` installs the frontend dependencies, including `pdfjs-dist` (v4), React, Zustand, and the Tauri JavaScript API. The first Tauri run will additionally compile the Rust backend, which takes a few minutes the first time and is cached afterward.

### OCR assets

OCR runs fully offline via a self-hosted `tesseract.js` (worker + WebAssembly core + English model). Those files are large and derived, so they are git-ignored and populated into `public/tesseract/` by `scripts/setup-ocr-assets.mjs`. The `predev` / `prebuild` npm hooks run it automatically, so `npm run dev`, `npm run build`, and `npm run tauri dev|build` just work; the first run downloads the ~2 MB English model once (network required) and caches it. To fetch them by hand: `npm run setup:ocr`.

## Develop

```bash
npm run tauri dev
```

This starts the Vite dev server for the frontend and launches the Tauri window pointing at it. You get:

- Hot module replacement for React/TypeScript changes.
- Automatic Rust recompilation and app restart when files under `src-tauri/src/` change.

The first launch is slow (Rust compiles the backend from scratch); subsequent launches are fast.

## Build a release bundle

```bash
npm run tauri build
```

This produces an optimized frontend, compiles the Rust backend in release mode, and packages a native installer for the current platform (for example, `.AppImage`/`.deb` on Linux, `.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows). Output lands under `src-tauri/target/release/bundle/`.

Cross-platform builds are handled in CI (`.github/`); locally, `tauri build` targets the OS you are running on.

## Quality checks

Run these before opening a pull request. They also run in CI.

```bash
npm run test        # Vitest unit tests
npm run lint        # ESLint over src/
npm run typecheck   # tsc --noEmit against tsconfig.json
```

End-to-end tests use **Playwright** and drive the browser build (served by the Vite dev server). Install the browser once with `npx playwright install chromium`, then run `npm run test:e2e`. See [testing.md](testing.md) for how the suite is organized.

Recommended pre-PR sequence:

```bash
npm run lint && npm run typecheck && npm run test
```

## Project layout

A map of the top-level directories. See `docs/architecture.md` for how they fit together.

```
folio/
├─ .github/                 # CI, issue/PR templates, dependabot, CODEOWNERS
├─ docs/                    # documentation (this file lives here)
│  └─ adr/                  # architecture decision records
├─ public/                  # static assets served by Vite
├─ src/                     # React + TypeScript frontend
│  ├─ ai/                   # AI layer: providers/ (Claude, experimental), mcp/ (stubs)
│  ├─ a11y/                 # accessibility utils (announcer, focus mgmt, shortcuts help)
│  ├─ assets/               # bundled assets (folio-logo.svg, the app-icon source)
│  ├─ commands/             # command registry: every user action is a Command
│  ├─ components/           # Viewer/, Toolbar/, Sidebar/, Search/, common/
│  ├─ core/                 # engine-agnostic PDF core: pdf/ (PdfEngine + PdfJsEngine), document/
│  ├─ features/             # annotations, editing (text/image), ocr, signatures, forms, export
│  ├─ plugins/              # plugin host + SDK types + builtins/ (Word Count)
│  ├─ state/                # Zustand stores
│  ├─ styles/               # global CSS
│  ├─ test/                 # test setup (Vitest)
│  └─ theme/                # ThemeProvider, design tokens, dark schemes
├─ src-tauri/               # Rust backend (Tauri 2): src/, icons/, capabilities/
├─ index.html · package.json · tsconfig.json · vite.config.ts · LICENSE · README.md
```

Where to start reading code:

- **`src/commands/`**: the registry; every action is a `Command`. Good entry point for understanding behavior.
- **`src/core/pdf/`**: `PdfEngine` interface and `PdfJsEngine`; all PDF access flows through here.
- **`src-tauri/src/`**: the Tauri commands (file IO, recent files, native menus, window state).

## Troubleshooting

**Pages stay blank / "worker not loading" errors.**
PDF.js runs its parser in a Web Worker, and the most common setup issue is the worker not being found. Folio configures this in `src/core/pdf/setupWorker.ts`, which imports `pdfjs-dist/build/pdf.worker.min.mjs?url` and assigns it to `GlobalWorkerOptions.workerSrc`; Vite then emits the worker as a hashed bundle asset. Confirm that import resolves and that Vite is emitting the worker. After changing worker configuration, do a clean restart of `npm run tauri dev`. If you see a version-mismatch warning, ensure the worker and `pdfjs-dist` are the same v4 version.

**`npm run tauri dev` fails to compile the backend on Linux.**
Almost always a missing system dependency. Reinstall the Linux set above, paying attention to `libwebkit2gtk-4.1-dev` (the **4.1**, not 4.0, package is required by Tauri 2). A `pkg-config` error naming `webkit2gtk-4.1` or `openssl` points directly at the missing `-dev` package.

**`webkit2gtk-4.1` not found even after installing.**
Your distribution may package it under a different name (see the Fedora/Arch equivalents above), or `pkg-config` cannot see it. Verify with `pkg-config --exists webkit2gtk-4.1 && echo ok`.

**Windows build fails with a linker (`link.exe`) or MSVC error.**
The Visual C++ Build Tools are missing or the Rust toolchain is set to GNU instead of MSVC. Install the "Desktop development with C++" workload and run `rustup default stable-msvc`.

**Windows app opens to a blank window.**
The WebView2 Runtime is missing. Install the Evergreen WebView2 runtime and relaunch.

**Icons look wrong or the build complains about icons.**
App icons live in `src-tauri/icons/`. Regenerate them from the SVG source with `npm run tauri icon src/assets/folio-logo.svg`, which produces the full platform icon set (see `src-tauri/icons/README.md`). On Linux, missing `librsvg2-dev` can cause icon rasterization to fail during the build.

**Rust build is very slow the first time.**
Expected. The initial backend compile builds all crates from scratch; later builds are incremental and much faster. Do not delete `src-tauri/target/` unless you intend to pay that cost again.

## Next steps

- `docs/architecture.md`: the full layer stack and data flow.
- `docs/accessibility.md`: keyboard shortcuts and the WCAG 2.2 AA approach.
- `docs/theming.md`: design tokens, dark mode, and dark schemes.
- `docs/adr/`: the decisions behind the stack.
