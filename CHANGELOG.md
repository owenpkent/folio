# Changelog

All notable changes to Folio are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/owenpkent/folio/commits/main
