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

## Module map

Each layer maps to a real directory in the repository.

| Layer | Directory | Responsibility |
|---|---|---|
| Rust backend | `src-tauri/src/` | File IO, recent files, native menus, window state; exposes Tauri commands |
| Static assets | `public/` | Icons, worker assets, and other files served verbatim by Vite |
| UI components | `src/components/` | `Viewer/`, `Toolbar/`, `Sidebar/`, `Search/`, `common/` |
| Command registry | `src/commands/` | Every user action as a `Command`; single dispatch point |
| PDF core | `src/core/` | `pdf/` (`PdfEngine` interface + `PdfJsEngine`), `document/` (document model) |
| State | `src/state/` | Zustand stores (document, viewport, ui, annotations, theme, plugins) |
| Theming | `src/theme/` | `ThemeProvider`, design tokens, reading modes |
| Accessibility | `src/a11y/` | Announcer (live region), focus management, shortcuts help |
| Annotations | `src/features/annotations/` | Annotation model, store, and tools |
| Plugins | `src/plugins/` | Plugin host, SDK types, `builtins/` |
| AI layer | `src/ai/` | `providers/` (`AIProvider` impls, Claude default), `mcp/` (planned) |

## Data flow: opening and rendering a PDF

The sequence below is the canonical path from a user gesture to pixels on screen.

```
User → Command "file.open"
  │
  ▼
Tauri dialog.open()  (native file picker, Rust side)
  │  returns a path
  ▼
Tauri command read_file(path)  → Uint8Array (bytes) back to the WebView
  │
  ▼
PdfEngine.loadDocument(bytes)
  │  hands bytes to PDF.js via getDocument()
  ▼
PDF.js Web Worker: parse structure, build cross-reference table, resolve fonts
  │  returns a document proxy (page count, metadata, outline)
  ▼
state/documentStore ← { pages, metadata, outline }
  │
  ▼
Viewer requests visible pages → PdfEngine.renderPage(n, { scale, canvas })
  │  worker decodes page content → main thread paints to <canvas>
  ▼
PdfEngine.getTextContent(n) → text layer <div> overlaid on the canvas
  │
  ▼
a11y announcer: "Page 1 of 24"   (polite live region)
```

Key points:

1. **The WebView never touches the file system directly.** It asks the Rust backend to open a dialog and read bytes. This keeps the security boundary explicit and lets Folio work with sandboxed WebView permissions.
2. **`loadDocument(source)` accepts bytes, not a path.** The engine is deliberately unaware of where the bytes came from, which keeps it portable and testable.
3. **Rendering is lazy and viewport-driven.** Only pages near the scroll position are rasterized. `viewportStore` reports which pages are visible; the `Viewer` renders those and recycles canvases as the user scrolls.
4. **The text layer is not optional.** Every rendered page gets a positioned text layer from `getTextContent`, which is what makes selection, find-in-page highlighting, and screen-reader reading work against the real glyphs rather than a rasterized image.

## The PDF engine abstraction

Folio does not call PDF.js from the UI. All PDF access goes through a single interface in `src/core/pdf`:

```ts
interface PdfEngine {
  loadDocument(source: ArrayBuffer | Uint8Array): Promise<PdfDocumentHandle>;
  getPageCount(): number;
  renderPage(pageNumber: number, opts: { scale: number; canvas: HTMLCanvasElement }): Promise<void>;
  getTextContent(pageNumber: number): Promise<TextContent>;
  getOutline(): Promise<OutlineItem[]>;
  getMetadata(): Promise<PdfMetadata>;
  search(query: string): Promise<SearchMatch[]>;
}
```

`PdfJsEngine` is the sole implementation today. It wraps `pdfjs-dist` v4: `loadDocument` calls `getDocument`, `renderPage` uses `page.render`, `getTextContent` uses `page.getTextContent`, and so on.

### Why PDF.js, and why the interface

- **Why PDF.js:** it is mature, MIT-licensed, actively maintained, renders to `<canvas>`, and already produces a positioned text layer that we need for accessibility. It runs in the WebView with no native rendering dependency, which keeps the desktop bundle simple.
- **Why abstract it:** PDF.js is a JavaScript renderer. For very large documents or heavy print production, a native rasterizer such as **PDFium** can be faster and more precise. By routing everything through `PdfEngine`, a future `PdfiumEngine` (likely a Tauri command backed by a Rust PDFium binding) can be swapped in without touching the UI, the command registry, or the stores. The interface is the seam.

Nothing above `src/core/pdf` imports `pdfjs-dist`. If you see a `pdfjs-dist` import outside `core/pdf`, that is a layering violation.

## PDF.js Web Worker threading model

PDF.js splits work across two threads:

- **Main thread (UI):** owns the DOM, canvases, and React. It sends commands (load, render, get text) and receives results.
- **Worker thread:** does the CPU-heavy work: parsing the file structure, decoding streams, resolving and rasterizing fonts, and extracting text content.

Folio configures `GlobalWorkerOptions.workerSrc` to point at the bundled `pdf.worker` asset (served from `public/` / emitted by Vite). Communication is `postMessage`-based and structured-clone friendly, so page bitmaps and text runs cross the boundary without blocking input handling.

Practical consequences:

- Scrolling stays smooth even while a large page decodes, because decode happens in the worker.
- A single worker is shared per document. Render requests are queued; the `Viewer` cancels off-screen render tasks (`RenderTask.cancel()`) when the user scrolls away, so the worker is not wasted on pages that are no longer visible.
- Worker configuration is the most common setup pitfall. See `getting-started.md` (troubleshooting) if pages fail to render with a "worker not loading" style error.

## State management (Zustand)

State is the single source of truth between the UI, commands, plugins, and the AI layer. Stores live in `src/state/` and are small, focused slices rather than one monolith.

| Store | Holds | Written by |
|---|---|---|
| `documentStore` | Loaded document handle, page count, outline, metadata, current page | `file.open` command, engine callbacks |
| `viewportStore` | Zoom/scale, fit mode (width/page), scroll position, visible page range | Zoom/fit commands, scroll handler |
| `uiStore` | Sidebar open/closed, active panel, command palette visibility, modal state | Toolbar, keyboard commands |
| `annotationStore` | Annotation model per page, active tool, selection | `features/annotations/` tools |
| `themeStore` | UI theme (light/dark/system), active reading mode | Theme commands, system preference listener |
| `pluginStore` | Registered plugins, their contributed commands and panels, enabled state | Plugin host on load/enable/disable |

Design rules:

- **Commands mutate state; components read it.** A React component should not orchestrate a workflow directly. It dispatches a command; the command updates the relevant store; components re-render from the store.
- **Stores never import from `components/`.** Data flows down, actions flow up through commands.
- **Persistence is selective.** UI theme and recent files are persisted (theme in local storage, recent files via the Rust backend). Transient view state such as scroll position is not.

## Extension points

Folio is designed to be extended without forking. The stable surfaces are:

1. **Commands (`src/commands`).** The primary extension point. Anything a user can do is a `Command`:

   ```ts
   interface Command {
     id: string;
     title: string;
     category?: string;
     keybinding?: string;
     when?: (ctx: CommandContext) => boolean;
     run(ctx: CommandContext): void | Promise<void>;
   }
   ```

   Keyboard shortcuts, the future command palette, plugins, and AI actions all dispatch through the same registry. `when` gates availability (for example, "a document is open"); `keybinding` wires a shortcut; `category` groups entries in the palette.

2. **Plugins (`src/plugins`).** A plugin is a module that receives the SDK and registers contributions: commands, sidebar panels, toolbar items, and reading-mode or annotation-tool additions. Built-ins in `plugins/builtins/` are written against the same SDK a third party would use, which keeps the SDK honest.

3. **Viewer regions.** The `Toolbar`, `Sidebar`, and overlay layers expose named slots that plugins can contribute React nodes into, so extensions surface UI without patching core components.

4. **AI providers (`src/ai/providers`).** New providers implement the `AIProvider` interface. Claude/Anthropic is the default. The UI and commands talk to the interface, never to a specific vendor SDK, so swapping or adding a provider is a registration, not a rewrite. `src/ai/mcp/` is reserved for the planned, experimental Model Context Protocol transport.

5. **Theme tokens (`src/theme`).** Plugins consume CSS custom properties (for example `--folio-surface`, `--folio-text`, `--folio-accent`) rather than hard-coded colors, so their UI follows the active theme and reading mode automatically. See `theming.md`.

6. **PDF engine (`src/core/pdf`).** Not a public plugin surface, but the same seam: implementing `PdfEngine` swaps the rendering backend.

## Tauri command boundary

The Rust backend in `src-tauri/src/` exists to do what a WebView should not do itself. It is intentionally thin: it owns native capabilities and persisted OS-level state, and exposes them as Tauri commands the frontend calls via `invoke()`.

Responsibilities on the Rust side:

- **File IO.** Open the native file dialog, read PDF bytes, and (for save/export) write files. The frontend receives bytes, never raw file-system access.
- **Recent files.** Maintain and persist the recent-documents list across sessions, and feed it to the native menu and the UI.
- **Native menus.** Build the OS application/menu bar (File, View, Help, and so on) and forward menu clicks to frontend commands so a menu item and a keyboard shortcut run the exact same `Command`.
- **Window state.** Persist and restore window size, position, and maximized state so Folio reopens the way the user left it.

Everything else, including all PDF parsing, rendering, text extraction, search, theming, and annotation logic, lives in the frontend/TypeScript layer. This keeps the Rust surface small, auditable, and stable, and it keeps the door open for the future native-rasterizer backend to be added as additional commands without disturbing the rest of the app.

## Related documents

- `docs/accessibility.md`: keyboard model, ARIA landmarks, live-region announcements, WCAG 2.2 AA mapping.
- `docs/theming.md`: design tokens, light/dark, and reading modes.
- `docs/getting-started.md`: environment setup and development workflow.
- `docs/adr/`: architecture decision records for the choices summarized here.
