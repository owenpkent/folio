# Changelog

All notable changes to Folio are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Forms and signing (v0.3, phase 1):
  - Fill interactive AcroForm fields (text, checkbox, radio, dropdown) rendered
    over each page via the PDF.js annotation layer.
  - Ink / visual signatures: create by drawing, typing, or uploading an image,
    then place, drag, and resize on the page. Stored per document.
  - Save a copy with form values written (PDF.js `saveDocument`) and signatures
    stamped in (pdf-lib), via a native save dialog or browser download
    (`Ctrl/Cmd + S`). Adds the Tauri fs plugin and a scoped write capability.
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

[Unreleased]: https://github.com/owenpkent/folio/commits/main
