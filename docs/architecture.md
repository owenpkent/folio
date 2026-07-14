# Folio Architecture

Folio is a desktop PDF viewer built on **Tauri 2** (Rust backend) with a **React 18 + TypeScript 5** frontend, bundled by **Vite 5**. Rendering is delegated to **PDF.js** (`pdfjs-dist` v4). Application state lives in **Zustand** stores. Theming is driven entirely by **CSS custom properties**.

This document describes the layer stack, the data flow for opening and rendering a PDF, the engine abstraction, the PDF.js worker threading model, state management, extension points, and the Tauri command boundary.

## Design goals that shaped the architecture

- **Fast rendering.** Parsing and rasterization happen off the UI thread. The main thread only paints canvases and manages the DOM.
- **Accessibility-first (WCAG 2.2 AA).** Every rendered page carries a real text layer for selection and screen-reader access. Every user action is a `Command` with a keybinding.
- **Dark-mode native.** Theme tokens and reading-mode filters are first-class, not bolted on.
- **Extensible.** A plugin host exposes stable SDK surfaces (commands, viewer regions, theme tokens) so third parties extend Folio without forking.
- **AI-ready.** A provider-agnostic AI layer sits behind an interface, with Claude/Anthropic as the default provider and MCP planned as an experimental transport.

## Layer stack

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          Tauri 2 shell (native window)                     │
│  WebView (Chromium/WebKit)                          Rust backend           │
│  ┌───────────────────────────────────────────┐    ┌──────────────────┐    │
│  │              React 18 UI layer             │    │  Tauri commands  │    │
│  │  components/  Viewer · Toolbar · Sidebar    │◄──►│  file IO         │    │
│  │              Search · common                │ IPC│  recent files    │    │
│  │                     │                       │    │  native menus    │    │
│  │        theme/       │        a11y/          │    │  window state    │    │
│  │  ThemeProvider  data-theme  announcer/focus │    └──────────────────┘    │
│  │                     ▼                       │            ▲               │
│  │              commands/  Command registry    │            │ invoke()      │
│  │        (keyboard · palette · plugins · AI)  │            │               │
│  │           │                     │           │            │               │
│  │  plugins/ host + SDK      ai/ providers     │            │               │
│  │           │                     │           │            │               │
│  │           ▼                     ▼           │            │               │
│  │  state/  Zustand stores (single source)     │            │               │
│  │           │                                 │            │               │
│  │           ▼                                 │            │               │
│  │  core/  PdfEngine (interface)               │            │               │
│  │         PdfJsEngine (impl)                  │            │               │
│  └───────────┼─────────────────────────────────┘            │               │
│              │ postMessage                                   │               │
│              ▼                                               │               │
│  ┌───────────────────────────────┐                          │               │
│  │  PDF.js Web Worker             │   file bytes ────────────┘               │
│  │  parse · decode · text extract │                                          │
│  └───────────────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

Read the stack top-down as: **native shell → React UI → command registry → plugin host / AI layer → Zustand state → core PDF engine → PDF.js worker**, with the Rust backend attached over Tauri IPC for anything the WebView cannot do safely (file system, OS menus, persisted window state).

> Implementation status: the diagram is the intended shape. Today the Rust backend implements file IO (`read_document`, `write_document`), the browser hand-off (`fetch_pdf`), `app_version`, the default-viewer launch handling (`take_launch_file`, `open_default_apps_settings`), and the updater/deep-link plugins; native menus, recent files, and persisted window state are planned (see "Tauri command boundary"). Likewise the command palette shown under `commands/` is planned, not yet built. Reading the diagram, treat those cells as the roadmap, not current behavior.

## Module map

Each layer maps to a real directory in the repository.

| Layer | Directory | Responsibility |
|---|---|---|
| Rust backend | `src-tauri/src/` | Implemented: file read/write (`read_document`, `write_document`), browser hand-off (`fetch_pdf`), `app_version`, default-viewer launch handling (`take_launch_file`, `open_default_apps_settings`), plus the dialog, updater, deep-link, single-instance, and process plugins. Planned: recent files, native menus, window state, secure store |
| Static assets | `public/` | Files served verbatim by Vite (currently empty; the PDF.js worker is bundled via a `?url` import, not placed here) |
| UI components | `src/components/` | `Viewer/`, `Toolbar/`, `Sidebar/`, `Search/`, `common/` (`common/` also holds `toastStore`) |
| Command registry | `src/commands/` | Every user action as a `Command`; single dispatch point |
| PDF core | `src/core/` | `pdf/` (`PdfEngine` interface + `PdfJsEngine`), `document/` (file picking and byte reading) |
| State | `src/state/` | `documentStore` and `viewerStore`; other Zustand stores are colocated with their feature (theme, ai, annotations, plugins) |
| Theming | `src/theme/` | `ThemeProvider`, design tokens (`tokens.css`), reading modes, `themeStore` |
| Accessibility | `src/a11y/` | Announcer (live region), focus trap, keyboard shortcut dispatch, skip link |
| Annotations | `src/features/annotations/` | Annotation model, `store` (localStorage sidecar), and tools |
| Signatures | `src/features/signatures/` | Visual signature creation (draw/type/upload), on-page placement, per-document `store` |
| Digital signing | `src/features/signing/` | Certificate identities (create/import .p12 via node-forge), PKCS#7 signing (@signpdf), and signature detection. Runs in the WebView today; a Rust/keychain backend is planned |
| Save / export | `src/features/export/` | Writes the filled PDF (PDF.js `saveDocument`) and stamps signatures with pdf-lib |
| Plugins | `src/plugins/` | Plugin host, SDK types, `contributionStore`, `builtins/` |
| AI layer | `src/ai/` | `aiStore`, `providers/` (`AIProvider` impls, Claude default), `mcp/` (experimental MCP transport) |

## Data flow: opening and rendering a PDF

The sequence below is the canonical path from a user gesture to pixels on screen.

```
User → Command "file.open"
  │
  ▼
dialog open()  (native picker via tauri-plugin-dialog; a hidden
  │             file input is the browser-dev fallback)
  │  returns a path
  ▼
Tauri command read_document(path)  → ArrayBuffer (bytes) back to the WebView
  │
  ▼
PdfEngine.loadDocument(source)   (source = { kind: 'bytes', data, name })
  │  hands bytes to PDF.js via getDocument()
  ▼
PDF.js Web Worker: parse structure, build cross-reference table, resolve fonts
  │  returns a document proxy (page count, metadata, outline)
  ▼
state/documentStore ← { info, metadata, outline }
  │
  ▼
Viewer requests visible pages → PdfEngine.renderPage(n, { scale, canvas })
  │  worker decodes page content → main thread paints to <canvas>
  ▼
PdfEngine.renderTextLayer(n, container, scale) → text layer overlaid on the canvas
  │
  ▼
a11y announcer: "Page 1 of 24"   (polite live region)
```

Key points:

1. **The WebView never touches the file system directly.** In the desktop app it asks the Rust `read_document` command for the bytes (the file picker itself is the dialog plugin). This keeps the security boundary explicit and lets Folio work with sandboxed WebView permissions. In a plain browser (`npm run dev` without Tauri) a hidden file input provides the bytes instead.
2. **`loadDocument(source)` accepts a `DocumentSource`, not a path.** The source carries either raw bytes (`{ kind: 'bytes', data, name }`) or a URL, so the engine is deliberately unaware of where the bytes came from, which keeps it portable and testable.
3. **Rendering is lazy and viewport-driven.** Only pages near the scroll position are rasterized. `viewerStore` tracks the current page and pending scroll target; the `Viewer` renders visible pages and recycles canvases as the user scrolls.
4. **The text layer is not optional.** Every rendered page gets a positioned text layer from `renderTextLayer` (backed by PDF.js text content; `getPageText` extracts the same text for search and AI), which is what makes selection, find-in-page highlighting, and screen-reader reading work against the real glyphs rather than a rasterized image.

## The PDF engine abstraction

Folio does not call PDF.js from the UI. All PDF access goes through a single interface in `src/core/pdf`:

```ts
interface PdfEngine {
  readonly isReady: boolean;
  loadDocument(source: DocumentSource): Promise<PdfDocumentInfo>;
  closeDocument(): Promise<void>;
  getPageDimensions(pageNumber: number, scale: number): Promise<PageDimensions>;
  renderPage(pageNumber: number, options: RenderPageOptions): Promise<void>;
  renderTextLayer(pageNumber: number, container: HTMLElement, scale: number): Promise<void>;
  renderAnnotationLayer(pageNumber: number, container: HTMLElement, scale: number): Promise<void>;
  getPageText(pageNumber: number): Promise<string>;
  getOutline(): Promise<OutlineNode[]>;
  getMetadata(): Promise<PdfMetadata>;
  search(query: string, options?: { limit?: number }): Promise<SearchMatch[]>;
  hasFormFields(): Promise<boolean>;
  getPendingEditCount(): number;
  saveDocument(): Promise<Uint8Array>;
}
```

Page count is not a method: it comes back on the `PdfDocumentInfo` that `loadDocument` resolves to (`info.numPages`), which the stores hold.

`PdfJsEngine` is the sole implementation today. It wraps `pdfjs-dist` v4: `loadDocument` calls `getDocument`, `renderPage` uses `page.render`, `renderTextLayer` and `getPageText` are built from `page.getTextContent`, and so on.

### Why PDF.js, and why the interface

- **Why PDF.js:** it is mature, MIT-licensed, actively maintained, renders to `<canvas>`, and already produces a positioned text layer that we need for accessibility. It runs in the WebView with no native rendering dependency, which keeps the desktop bundle simple.
- **Why abstract it:** PDF.js is a JavaScript renderer. For very large documents or heavy print production, a native rasterizer such as **PDFium** can be faster and more precise. By routing everything through `PdfEngine`, a future `PdfiumEngine` (likely a Tauri command backed by a Rust PDFium binding) can be swapped in without touching the UI, the command registry, or the stores. The interface is the seam.

Nothing above `src/core/pdf` imports `pdfjs-dist`. If you see a `pdfjs-dist` import outside `core/pdf`, that is a layering violation.

## PDF.js Web Worker threading model

PDF.js splits work across two threads:

- **Main thread (UI):** owns the DOM, canvases, and React. It sends commands (load, render, get text) and receives results.
- **Worker thread:** does the CPU-heavy work: parsing the file structure, decoding streams, resolving and rasterizing fonts, and extracting text content.

`setupWorker.ts` sets `GlobalWorkerOptions.workerSrc` (once, idempotently) to a hashed worker URL that Vite emits from a `pdfjs-dist/build/pdf.worker.min.mjs?url` import, so the worker travels with the bundle rather than being copied into `public/`. Communication is `postMessage`-based and structured-clone friendly, so page bitmaps and text runs cross the boundary without blocking input handling.

Practical consequences:

- Scrolling stays smooth even while a large page decodes, because decode happens in the worker.
- A single worker is shared per document. Render requests are queued; the `Viewer` cancels off-screen render tasks (`RenderTask.cancel()`) when the user scrolls away, so the worker is not wasted on pages that are no longer visible.
- Worker configuration is the most common setup pitfall. See `getting-started.md` (troubleshooting) if pages fail to render with a "worker not loading" style error.

## State management (Zustand)

State is the single source of truth between the UI, commands, plugins, and the AI layer. Stores are small, focused Zustand slices rather than one monolith. Two live in `src/state/`; the rest are colocated with the feature they serve, so a store sits next to the code that owns it.

| Store | File | Holds | Written by |
|---|---|---|---|
| `documentStore` | `src/state/documentStore.ts` | Load status, document `info`, metadata, outline, error | `loadSource`/`closeDocument` actions |
| `viewerStore` | `src/state/viewerStore.ts` | Scale, fit mode (custom/width/page), current page, page count, sidebar open + active tab, search open, pending scroll target | Zoom/nav/sidebar commands, scroll handler |
| `themeStore` | `src/theme/themeStore.ts` | UI theme (light/dark/system), resolved theme, reading mode | Theme commands, system preference listener |
| `aiStore` | `src/ai/aiStore.ts` | AI enabled flag, selected provider id (disabled by default) | AI settings UI |
| annotation store (`useAnnotationStore`) | `src/features/annotations/store.ts` | Current document fingerprint and its annotations | `features/annotations/` tools |
| contribution store (`useContributionStore`) | `src/plugins/contributionStore.ts` | Plugin-contributed toolbar items, sidebar panels, annotation tools | Plugin host on activate/deactivate |
| `toastStore` | `src/components/common/toastStore.ts` | Transient toast notifications | `pushToast` (commands, plugins) |

That is seven stores today. There is no separate `viewportStore` or `uiStore`: view and UI state (zoom, fit, sidebar, search) all live in `viewerStore`. There is no `pluginStore`; plugin UI contributions live in `contributionStore`.

Design rules:

- **Commands and actions mutate state; components read it.** A React component should not orchestrate a workflow directly. It dispatches a command (or calls a state action); that updates the relevant store; components re-render from the store.
- **Stores never import from `components/`.** Data flows down, actions flow up through commands.
- **Persistence is selective.** UI theme and reading mode are persisted in local storage (`themeStore`), and annotations are persisted per document fingerprint in local storage (`features/annotations/store.ts`). Transient view state such as scroll position is not. A recent-files list persisted via the Rust backend is planned, not yet implemented.

## Extension points

Folio is designed to be extended without forking. The stable surfaces are:

1. **Commands (`src/commands`).** The primary extension point. Anything a user can do is a `Command`:

   ```ts
   interface Command {
     id: string;
     title: string;
     category?: string;
     keybinding?: string;
     when?: () => boolean;
     run(ctx?: CommandContext): void | Promise<void>;
   }
   ```

   Keyboard shortcuts, the future command palette, plugins, and AI actions all dispatch through the same registry. `when` gates availability (for example, "a document is open"); `keybinding` wires a shortcut; `category` groups entries in the palette.

2. **Plugins (`src/plugins`).** A plugin is a module that receives the SDK and registers contributions: commands, sidebar panels, toolbar items, and reading-mode or annotation-tool additions. Built-ins in `plugins/builtins/` are written against the same SDK a third party would use, which keeps the SDK honest.

3. **Viewer regions.** The `Toolbar`, `Sidebar`, and overlay layers expose named slots that plugins can contribute React nodes into, so extensions surface UI without patching core components.

4. **AI providers (`src/ai/providers`).** New providers implement the `AIProvider` interface. Claude/Anthropic is the default. The UI and commands talk to the interface, never to a specific vendor SDK, so swapping or adding a provider is a registration, not a rewrite. `src/ai/mcp/` holds an experimental Model Context Protocol client and server (`McpClient`, `McpServer`); AI is disabled by default, so nothing is sent anywhere until the user turns it on.

5. **Theme tokens (`src/theme`).** Plugins consume CSS custom properties (for example `--folio-surface`, `--folio-text`, `--folio-accent`) rather than hard-coded colors, so their UI follows the active theme and reading mode automatically. See `theming.md`.

6. **PDF engine (`src/core/pdf`).** Not a public plugin surface, but the same seam: implementing `PdfEngine` swaps the rendering backend.

## Tauri command boundary

The Rust backend in `src-tauri/src/` exists to do what a WebView should not do itself. It is intentionally thin: it owns native capabilities and exposes them as Tauri commands the frontend calls via `invoke()`.

Implemented today (`src-tauri/src/lib.rs`), the registered commands are:

- **`read_document(path)`.** Read a PDF from disk and return its raw bytes to the frontend. It returns a Tauri `Response` (a binary body the frontend receives as an `ArrayBuffer`) rather than a JSON array, so a multi-megabyte PDF is not serialized number-by-number. It rejects paths that do not end in `.pdf`. The frontend receives bytes, never raw file-system access.
- **`write_document(path, contents)`.** Write a filled/signed copy to the path the user chose in the native save dialog. Living on the Rust side (it mirrors `read_document`) means the frontend needs **no** broad filesystem capability — the previous `fs:allow-write-file` (`$HOME/**`) scope was removed. Rejects non-`.pdf` paths.
- **`fetch_pdf(url)`.** Download a PDF handed off from the browser extension's `folio://` deep link. Validates the scheme (http/https only), refuses local/private hosts (an SSRF guard), and caps the response size. Cookie-gated PDFs are out of scope here (no browser session) — the extension's in-browser viewer covers those.
- **`app_version()`.** Return the running version string, sourced from `Cargo.toml`.
- **`take_launch_file()`.** Return (and clear) the PDF path Folio was launched with as the default `.pdf` handler. The path is captured from the process arguments at startup, validated (must end in `.pdf` and exist on disk), and consumed exactly once by the frontend on mount, so an in-app reload does not silently re-open it.
- **`open_default_apps_settings()`.** Open the OS "Default apps" settings so the user can make Folio the default PDF viewer. Windows launches the fixed `ms-settings:defaultapps` URI (no user input is interpolated); modern Windows does not permit an app to seize a default handler silently, so this is a guided deep link rather than a silent switch.

The native open and save pickers are provided by `tauri-plugin-dialog`; the document is prepared for saving in the frontend (PDF.js `saveDocument()` writes filled form values, then pdf-lib stamps placed signatures — see `src/features/export/`) and the bytes are written by `write_document`. Also registered in `run()`: `tauri-plugin-updater` (in-app updates, desktop only), `tauri-plugin-deep-link` + `tauri-plugin-single-instance` (the `folio://` scheme and single-window URL routing), and `tauri-plugin-process` (relaunch after an update). See `docs/releasing.md` for the signing and update-manifest flow.

Opening a PDF as the **default viewer** has two entry points, handled in `src/features/fileopen/`. On a cold start the OS launches Folio with the file path in `argv`; `run()` captures it and the frontend pulls it via `take_launch_file`. When Folio is already running, a second launch is intercepted by `tauri-plugin-single-instance`, which forwards the path to the existing window as a `folio:open-pdf` event (macOS delivers the file as an `Opened` run event instead of argv; that branch is wired but untested). The `.pdf` association itself is registered by the installer from `bundle.fileAssociations` in `tauri.conf.json`.

Planned Rust-side responsibilities (documented in the `lib.rs` module comment, not yet built):

- **Recent files.** Maintain and persist the recent-documents list across sessions, and feed it to the native menu and the UI.
- **Native menus.** Build the OS application/menu bar (File, View, Help, and so on) and forward menu clicks to frontend commands so a menu item and a keyboard shortcut run the exact same `Command`.
- **Window state.** Persist and restore window size, position, and maximized state so Folio reopens the way the user left it.
- **Secure store.** Hold AI provider credentials in OS-native secure storage.

Everything else, including all PDF parsing, rendering, text extraction, search, theming, and annotation logic, lives in the frontend/TypeScript layer. This keeps the Rust surface small, auditable, and stable, and it keeps the door open for the future native-rasterizer backend to be added as additional commands without disturbing the rest of the app.

## Security

- **Content Security Policy.** The desktop shell defines a strict `app.security.csp` (`src-tauri/tauri.conf.json`): `default-src 'self'` with narrowly scoped `script`/`style`/`img`/`font`/`connect`/`worker` sources and `object-src 'none'`. It permits the bundled assets, the PDF.js worker (`worker-src 'self' blob:`) and its wasm image codecs (`'wasm-unsafe-eval'`), plus the opt-in Anthropic API (`connect-src https://api.anthropic.com`) — no other remote origins.
- **VS Code extension.** The [VS Code extension](../extensions/vscode/README.md) renders in a webview under a strict, nonce-locked CSP (`default-src 'none'`, `script-src 'nonce-…'`). Attacker-controlled input (an opened PDF's filename) reaches the webview HTML only through `escapeHtml` or `asWebviewUri` encoding; both paths are fuzzed (see `extensions/vscode/fuzz/`).
- **Chrome extension.** The [Chrome extension](../extensions/chrome/README.md) runs under an MV3 extension CSP (`script-src 'self' 'wasm-unsafe-eval'`). It either hands PDFs to the desktop app via `folio://` or renders them in Folio's bundled viewer; the desktop side validates the handed-off URL in `fetch_pdf`.
- **Native boundary.** File IO is confined to Rust commands: `read_document` and `write_document` reject non-`.pdf` paths, there is no broad frontend filesystem capability, and `fetch_pdf` validates the URL and blocks local/private hosts (see the Tauri command boundary above).

## Related documents

- `docs/accessibility.md`: keyboard model, ARIA landmarks, live-region announcements, WCAG 2.2 AA mapping.
- `docs/theming.md`: design tokens, light/dark, and reading modes.
- `docs/getting-started.md`: environment setup and development workflow.
- `docs/adr/`: architecture decision records for the choices summarized here.
