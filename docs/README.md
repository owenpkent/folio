# Folio documentation

Folio is a fast, accessible, open-source PDF viewer and editor for the desktop
(Tauri + React) and the browser. This is the index to everything written down
about it.

New here? Start with **[Getting started](getting-started.md)**, then
**[Architecture](architecture.md)** for how the pieces fit together.

## By what you are doing

### Using Folio

| Document | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Install, run in dev, build, project layout, and troubleshooting. |
| [Accessibility](accessibility.md) | The keyboard map, focus rules, ARIA structure, the text layer, dark mode and dark schemes, and the WCAG 2.2 AA approach. |
| [Editing and OCR](editing-and-ocr.md) | Text boxes, images, editing text already on a page, and recognising text on scanned pages. |
| [Forms and signatures](forms-and-signatures.md) | Filling AcroForms, placing ink signatures, and certificate-based digital signing. |
| [Theming](theming.md) | Design tokens, light/dark, and the dark reading schemes. |

### Building on Folio

| Document | What it covers |
| --- | --- |
| [Architecture](architecture.md) | The command registry, the `PdfEngine` abstraction, the layer stack, and the rules that are easy to break by accident. |
| [Writing plugins](plugins.md) | The plugin host, contribution points, and the public API surface. |
| [AI and MCP](ai.md) | The AI layer and the Model Context Protocol integration. |

### Contributing

| Document | What it covers |
| --- | --- |
| [Contributing guide](../CONTRIBUTING.md) | Branching, Conventional Commits, the DCO sign-off, and review expectations. |
| [Testing](testing.md) | What is covered, how to run it, and which behaviours are pinned on purpose. |
| [Releasing](releasing.md) | Signed installers and the auto-updater. |
| [Release checklist](release-checklist.md) | The step-by-step for cutting a release. |

### Compliance and procurement

| Document | What it covers |
| --- | --- |
| [Section 508 conformance](508-conformance.md) | How Folio maps to the Revised 508 Standards, the provisions WCAG does not cover, the open gaps stated plainly, and how to produce an ACR. |
| [Security policy](../SECURITY.md) | Reporting a vulnerability and the support window. |

## The short version

A few things worth knowing before reading anything else, because they explain
most of the design:

- **Every user action is a `Command`.** Keyboard access and menu access run the
  same code path, so a feature registered with a `keybinding` is keyboard
  accessible for free. See [architecture.md](architecture.md).
- **Nothing calls PDF.js directly except the engine.** All PDF access goes
  through the `PdfEngine` interface in `src/core/pdf`, which is what would let
  the renderer be replaced without touching the UI.
- **The text layer is not optional.** Every page is a raster `<canvas>` with real
  positioned text over it. That text layer is what screen readers read, what
  selection copies, and what search highlights — the canvas is `aria-hidden`.
- **Accessibility is a requirement, not a later pass.** The target is WCAG 2.2
  AA. Section 508 incorporates WCAG 2.0 A/AA by reference, so that target is a
  superset of it — the gaps that remain are catalogued in
  [508-conformance.md](508-conformance.md) rather than glossed over.
