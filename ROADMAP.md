# Folio Roadmap

Folio is an open-source, MIT-licensed PDF viewer aiming at Adobe Acrobat-caliber quality: fast rendering, accessibility-first (WCAG 2.2 AA), dark-mode native, extensible through a plugin system, and AI-ready. The stack is Tauri 2 (Rust) with React 18, TypeScript 5, and Vite 7, rendering via PDF.js (`pdfjs-dist` v4), Zustand for state, CSS-variable theming, and Vitest plus Playwright for tests.

This roadmap is a direction, not a contract. Milestones ship when they are correct and accessible, not on a fixed date. Each phase lists what "done" means so progress is legible.

Phase numbers name thematic milestones, not app release versions. A release ships whatever is done, so the app's version can run ahead of a phase that is still open: Folio 0.2.0 already carried early v0.4-phase editing and OCR work, and Folio 0.4.0 ships while this phase's page operations and redaction remain planned.

Status legend: **Planned** (designed, not started), **In progress**, **Done**.

## Guiding principles

These hold across every phase and are how proposals are judged:

- **Accessibility is a release gate, not a phase.** Every feature ships keyboard-operable and screen-reader-labeled, meeting WCAG 2.2 AA. A feature that is not accessible is not done.
- **Rendering stays fast.** Large documents open quickly and scroll smoothly. Performance regressions block release.
- **The plugin API is the extension surface.** New capabilities are exposed through the public plugin and command APIs so third parties reach the same surface built-ins do.
- **AI and cloud features are opt-in and local-first.** Nothing leaves the machine unless the user turns it on. See [docs/ai.md](./docs/ai.md).
- **Dark mode and theming are native**, driven by CSS variables, not bolted on.

## v0.1 Foundation

The core viewer: open a PDF and read it comfortably, fully by keyboard, fully with a screen reader.

| Area | Deliverable | Status |
| --- | --- | --- |
| Open and render | Open local PDFs, render pages via PDF.js with a lazily-rendered page list | Done |
| Navigate | Page navigation, go-to-page, continuous scroll, hand/pan tool (plus middle-click pan in any mode), and teleprompter auto-scroll (single-page mode planned) | Done |
| Zoom and fit | Zoom in/out (snapping to clean preset levels), fit-width, fit-page, and actual-size (per-page rotation planned) | Done |
| Search | Full-text search with a results list and next/previous navigation | Done |
| Thumbnails | Thumbnail sidebar panel for page navigation | Done |
| Outline | Bookmarks/outline sidebar panel with jump-to-destination | Done |
| Dark mode | Native dark theme via CSS variables, following the OS by default; unified so dark inverts the rendered page at raster time (crisp on HiDPI), with selectable Night/Green/Amber reading schemes | Done |
| Accessibility | Full keyboard operation, focus management, ARIA labeling, screen-reader page announcements, visible focus, reduced-motion support | Done |
| Command registry | Global command registry backing keybindings, palette, and toolbar (see [docs/plugins.md](./docs/plugins.md)) | Done |
| Plugin host | `PluginHost` loading plugins against the public API; ships a built-in Word Count plugin | Done |

**Milestone: readable and operable.** A user can open a document, find text, navigate by outline and thumbnails, and do all of it by keyboard and with a screen reader, in light or dark mode. Plugins can contribute commands, toolbar items, and panels.

## v0.2 Annotations

Mark up documents. Annotations persist to a sidecar file and can be embedded back into the PDF.

Text highlighting with sidecar (local) persistence and an annotations panel already shipped in v0.1 as the foundation for this phase; the rest builds on it.

| Area | Deliverable | Status |
| --- | --- | --- |
| Text markup | Highlight (shipped), plus underline and strikethrough over the text layer | In progress |
| Notes | Sticky notes anchored to a point or region: place, drag, edit, delete; each note captures its page, position, and nearby text so the AI layer can locate it | In progress (place/drag/edit + AI anchoring shipped; keyboard placement planned) |
| Freehand | Ink annotations with pressure-agnostic smoothing | Planned |
| Shapes | Rectangle, ellipse, line, and arrow tools | Planned |
| Persistence | Sidecar storage of annotations (shipped), plus embed-into-PDF on save: highlights and notes are written as real `/Highlight` and `/Text` annotations (shipped); ink, shapes and underline/strikethrough follow their tools | In progress |
| Plugin tools | `registerAnnotationTool` so plugins add custom annotation tools | Planned |
| Accessibility | Keyboard-createable and editable annotations; annotations list panel (shipped); screen-reader descriptions | In progress |

**Milestone: mark up and save.** A user can highlight, note, draw, and add shapes, review them in an annotations panel, and save them either alongside the PDF (sidecar) or embedded into the file. Plugins can add annotation tools through the public API.

## v0.3 Forms & Signatures

Fill forms and sign documents. Signing lands in two phases: ink/visual
signatures first, then certificate-based digital signatures. See
[docs/forms-and-signatures.md](docs/forms-and-signatures.md).

| Area | Deliverable | Status |
| --- | --- | --- |
| AcroForm fill | Fill and save interactive AcroForm fields (text, checkbox, radio, choice) | Done |
| Save filled/signed copy | Export a copy with form values and signatures baked in | Done |
| Ink / visual signatures | Draw, type, or upload a signature; place it by clicking the spot, then drag and resize it; recent names are remembered | Done |
| Form navigation | Tab-order field navigation, validation feedback | In progress (native field focus works) |
| Signing (cryptographic) | Certificate-based PKCS#7 detached signing; import a .p12 or create a self-signed identity | Done (PAdES profiles and RFC 3161 timestamps planned) |
| Signature verification | Detect signatures; show signer, signing time, and post-signing tamper status | In progress (certificate-chain trust and CMS digest validation planned) |
| Accessibility | Fields announced with label, type, state, and required status | In progress (native inputs; signature placement has a keyboard path, keyboard repositioning and resizing planned) |

**Milestone: complete a form and sign it (shipped).** A user can fill an
AcroForm, add a visual signature, and cryptographically sign the document with an
imported or self-signed certificate, then save a copy. Full trust-chain
verification, timestamps, and a Rust/keychain signing backend are the remaining
phase-2 work. (XFA forms are out of scope; see Non-goals.)

## v0.4 Editing & OCR

Change document content, reorganize pages, make scans searchable, and redact.

| Area | Deliverable | Status |
| --- | --- | --- |
| Add text and images | Place text boxes and images on a page; baked into a saved copy | Done |
| Edit existing content | Edit text runs already in the PDF and replace/move embedded images | In progress (text runs done; embedded image replace/move planned) |
| OCR | Recognize text in scanned pages and add a searchable text layer | Done (English via tesseract.js; invisible baked layer + on-screen selection) |
| Page operations | Insert, delete, reorder, rotate, split, and merge pages | Planned |
| Redaction | True redaction that removes underlying content, not just a black box | Planned |
| Accessibility | Editing operations keyboard-driven; OCR output feeds search and screen readers | In progress (OCR text feeds search; more languages planned) |

**Milestone: edit, reorganize, and redact.** A user can edit content, restructure pages, run OCR to make a scan searchable, and redact sensitive content so it is actually gone.

## v0.5 AI & MCP

General availability of the AI features and MCP integration. See [docs/ai.md](./docs/ai.md) for the design.

An experimental, opt-in Claude provider and a stubbed MCP tool surface already exist as v0.1 scaffolding (off by default, no bundled keys); this phase brings them to general availability.

| Area | Deliverable | Status |
| --- | --- | --- |
| Summarize | Document summarization, streaming, multiple styles | Planned |
| Ask | Chat grounded in the document's extracted text | Planned |
| Extract | Structured data extraction to a user-defined JSON schema | Planned |
| Providers | Provider-agnostic layer; Claude (Anthropic) default, bring-your-own-key; local provider support | Planned |
| MCP client | Folio's assistant can call external MCP tools | Planned |
| MCP server | Folio exposes tools (`open_document`, `search`, `get_outline`, `extract_text`, `add_annotation`, `get_page_image`) so an external assistant can drive it | Planned |
| Privacy | Opt-in, local-first posture; keys in the OS keychain; explicit consent for what is sent | Planned |
| Accessibility | AI results panels and chat fully keyboard and screen-reader accessible | Planned |

**Milestone: AI GA.** Summarize, Ask, and Extract are stable and provider-agnostic, keys are stored securely, and the MCP client and server directions are generally available and opt-in.

## Non-goals

Saying no keeps Folio focused. These are explicitly out of scope, at least through v1:

- **Not a desktop publishing tool.** Folio is a viewer and annotator, not an InDesign or full DTP replacement. Complex layout authoring is out of scope.
- **Not a browser extension in v1.** Folio is a desktop app first. A standalone browser extension or public web build is not a v1 goal. (A **preview** VS Code extension that embeds the viewer in an editor tab exists at [extensions/vscode](extensions/vscode/README.md); it reuses the same React app through a webview and does not change the desktop-first focus.)
- **Not a cloud service.** No Folio-hosted accounts, sync service, or document storage. Documents stay on your machine; any cloud AI is opt-in and provider-supplied.
- **No XFA forms.** Dynamic XFA forms are a legacy Adobe format and are not planned. AcroForm support (v0.3) covers the standard interactive form model.
- **Not a scanner driver.** Folio consumes PDFs and images; it does not drive scanner hardware. OCR (v0.4) operates on already-scanned pages.
- **No bundled AI model or keys.** Folio ships no model weights and no API keys. AI is bring-your-own-key or bring-your-own-local-model.
- **No telemetry or analytics.** Folio does not phone home.

## How to influence the roadmap

This is an open-source project and the roadmap is meant to be shaped by its users and contributors.

- **Open an issue** to propose a feature, report a gap, or argue that a non-goal should change. Concrete use cases move things faster than abstract requests.
- **Weigh priorities.** If a v0.4 item matters more to you than a v0.2 item, say so in an issue. Ordering within and across phases is negotiable when the demand is there.
- **Prototype it as a plugin.** Many ideas can ship first as a plugin against the public API (see [docs/plugins.md](./docs/plugins.md)). A working plugin is the strongest possible case for pulling a capability into core.
- **Contribute.** Pick up an issue, or open a draft PR for discussion. Accessibility and performance are release gates, so land features with keyboard support, labeling, and no regressions from the start.

License: MIT. Contact: Owenpkent@gmail.com.
