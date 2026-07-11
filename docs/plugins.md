# Writing Folio Plugins

Folio is extensible. Almost everything the built-in UI does (adding a toolbar button, contributing a sidebar panel, defining an annotation tool, reacting to a document opening) is available to plugins through the same public API. Built-in features under `src/plugins/builtins/` are written against exactly the contract described here, so there is no privileged internal path that third-party plugins cannot reach.

This guide covers plugin anatomy and lifecycle, every contribution point on `PluginContext`, a complete worked example, how the `PluginHost` discovers and activates plugins, storage, event hooks, versioning, and the current security model.

- Command registry contract: [`src/commands`](../src/commands)
- Plugin API and host: [`src/plugins`](../src/plugins)
- Built-in plugins: [`src/plugins/builtins`](../src/plugins/builtins)

## Anatomy of a plugin

A plugin is an object that satisfies `FolioPlugin`. The only required members are an identity (`id`, `name`, `version`) and an `activate` function. Everything a plugin contributes is registered from inside `activate`, using the `PluginContext` it receives.

```ts
// @folio/plugin-api is the public type surface exported from src/plugins/api.ts
import type { FolioPlugin, PluginContext } from '@folio/plugin-api';

const plugin: FolioPlugin = {
  id: 'com.example.hello',   // reverse-DNS, globally unique, stable across versions
  name: 'Hello',             // human-readable, shown in the plugin manager
  version: '1.0.0',          // semver of the plugin itself

  activate(ctx: PluginContext) {
    ctx.ui.showToast('Hello from a plugin');
  },
};

export default plugin;
```

### The `FolioPlugin` interface

```ts
interface FolioPlugin {
  id: string;       // reverse-DNS, e.g. "com.example.wordcount"
  name: string;
  version: string;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

- `id` is the identity the host keys everything on: storage namespace, settings, enable/disable state, and dependency references. Never change it between releases (change `version` instead).
- `activate` runs once when the plugin is activated (see [Activation](#how-pluginhost-loads-and-activates-plugins)). It may be async; the host awaits it before considering the plugin ready.
- `deactivate` is optional but strongly recommended if you hold any resource the `Disposable` chain does not cover (timers, `AbortController`s, external sockets).

## Lifecycle and `Disposable` cleanup

Every `register*` and `on*` call on `PluginContext` returns a `Disposable`:

```ts
interface Disposable {
  dispose(): void;
}
```

A plugin is responsible for disposing everything it registered when it is deactivated. The idiomatic pattern is to collect disposables and tear them all down in `deactivate`. Do not rely on the host to guess what you own.

```ts
import type { FolioPlugin, PluginContext, Disposable } from '@folio/plugin-api';

let subscriptions: Disposable[] = [];

const plugin: FolioPlugin = {
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',

  activate(ctx: PluginContext) {
    subscriptions.push(
      ctx.registerCommand({
        id: 'hello.greet',
        title: 'Hello: Greet',
        run: () => ctx.ui.showToast('Hi'),
      }),
    );
    subscriptions.push(ctx.onDocumentOpen((doc) => ctx.ui.showToast(`Opened ${doc.title}`)));
  },

  deactivate() {
    for (const d of subscriptions) d.dispose();
    subscriptions = [];
  },
};

export default plugin;
```

Why this matters: Folio can enable and disable a plugin without restarting the app. If `deactivate` leaves a toolbar item or an event handler behind, that stale contribution keeps firing against a context that no longer exists. Disposing on deactivate is what makes hot enable/disable safe.

## Contribution points: the `PluginContext`

```ts
interface PluginContext {
  readonly apiVersion: string;   // semver of the host plugin API, e.g. "0.1.0"

  registerCommand(cmd: Command): Disposable;
  registerToolbarItem(item: ToolbarItem): Disposable;
  registerSidebarPanel(panel: SidebarPanel): Disposable;
  registerAnnotationTool(tool: AnnotationTool): Disposable;

  onDocumentOpen(handler: (doc: DocumentInfo) => void): Disposable;
  onPageRender(handler: (e: PageRenderEvent) => void): Disposable;

  getActiveDocument(): DocumentInfo | null;

  storage: PluginStorage;
  ui: PluginUi;
}
```

### Commands

Commands are the single dispatch mechanism in Folio. Keyboard shortcuts, toolbar clicks, menu items, plugin actions, and AI actions all resolve to a command id and run through the global registry.

```ts
interface Command {
  id: string;                              // unique, namespaced by convention: "wordcount.recount"
  title: string;                           // shown in the command palette
  category?: string;                       // groups related commands in the palette
  keybinding?: string;                     // e.g. "Ctrl+Shift+W" (Cmd on macOS)
  when?: (ctx: CommandContext) => boolean; // enablement predicate, evaluated on each dispatch
  run(ctx: CommandContext): void | Promise<void>;
}
```

`ctx.registerCommand(cmd)` forwards to the global `commandRegistry.register(cmd)`. Anything can then invoke it:

```ts
import { commandRegistry } from '@folio/commands';

await commandRegistry.execute('wordcount.recount');
await commandRegistry.execute('viewer.goToPage', { page: 12 }); // args flow to CommandContext.args
```

The `CommandContext` passed to `run` and `when` gives read access to app state at dispatch time:

```ts
interface CommandContext {
  getActiveDocument(): DocumentInfo | null;
  readonly viewer: ViewerApi;              // navigation and zoom (goToPage, setZoom, rotate, ...)
  readonly selection: TextSelection | null; // current text-layer selection, if any
  readonly args?: unknown;                 // second argument passed to commandRegistry.execute
}
```

Use `when` to keep a command out of the palette and disable its keybinding when it cannot run. It is re-evaluated on every dispatch, so it must be cheap and side-effect free.

### Toolbar items

A toolbar item is a visual affordance that runs a command. It carries no logic of its own, which keeps behavior testable through the command registry and keeps a single source of truth for enablement (the command's `when`).

```ts
interface ToolbarItem {
  id: string;
  commandId: string;                       // the command executed on click
  icon: string;                            // Folio icon name, or an inline SVG string
  tooltip?: string;
  group?: 'navigation' | 'view' | 'annotate' | 'tools';
  order?: number;                          // lower numbers sort earlier within the group
}
```

### Sidebar panels

Sidebar panels contribute to the left rail alongside Thumbnails, Outline, and Annotations. The `mount` contract is deliberately framework-neutral so third-party plugins are not forced to depend on React or on Folio's internal component tree. You are handed a container element; return an optional cleanup function that runs on unmount.

```ts
interface SidebarPanel {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  // Return an optional teardown callback. Called when the panel is unmounted
  // (user switches panels, or the plugin is deactivated).
  mount(container: HTMLElement, ctx: PluginContext): void | (() => void);
}
```

Built-in panels may render with React directly; third-party panels typically manipulate the DOM inside `container` or mount their own micro-framework. Either is fine. The container is owned by Folio: do not reach outside it into the rest of the DOM.

### Annotation tools

Annotation tools plug into the annotation layer described in the [roadmap](../ROADMAP.md) v0.2 milestone. A tool receives normalized pointer events in PDF page coordinates and returns an `AnnotationDraft` on completion, which Folio persists through the same pipeline as the built-in highlight and ink tools.

```ts
interface AnnotationTool {
  id: string;
  label: string;
  icon: string;
  cursor?: string;                         // CSS cursor while the tool is active
  onPointerDown?(e: AnnotationPointerEvent): void;
  onPointerMove?(e: AnnotationPointerEvent): void;
  // Returning a draft commits an annotation; returning void cancels the gesture.
  onPointerUp?(e: AnnotationPointerEvent): AnnotationDraft | void;
}

interface AnnotationPointerEvent {
  readonly pageNumber: number;
  readonly point: { x: number; y: number }; // PDF user-space units, origin bottom-left
  readonly modifiers: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean };
}
```

### Event hooks

Two document lifecycle hooks are stable in v0.1. Both return a `Disposable`.

```ts
onDocumentOpen(handler: (doc: DocumentInfo) => void): Disposable;
onPageRender(handler: (e: PageRenderEvent) => void): Disposable;
```

`onDocumentOpen` fires after a document is parsed and the first page is ready. `onPageRender` fires each time a page is rasterized to a canvas, which is the correct place to draw per-page overlays (badges, watermarks, search-hit boxes). Because it can fire dozens of times during fast scrolling, keep the handler cheap and idempotent.

```ts
// A minimal overlay plugin: draw a small page number badge on every rendered page.
ctx.onPageRender((e: PageRenderEvent) => {
  const badge = document.createElement('div');
  badge.className = 'example-page-badge';
  badge.textContent = String(e.pageNumber);
  e.overlay.appendChild(badge); // overlay is a positioned layer above the canvas
});
```

```ts
interface PageRenderEvent {
  readonly pageNumber: number;
  readonly scale: number;                  // current render scale (device pixels per PDF unit)
  readonly canvas: HTMLCanvasElement;      // the rendered page canvas (read-only for overlays)
  readonly textLayer: HTMLElement | null;  // selectable text layer, if generated
  readonly overlay: HTMLElement;           // plugin-writable layer, cleared on re-render
  readonly document: DocumentInfo;
}
```

### The active document

`getActiveDocument()` returns a `DocumentInfo`, or `null` when no document is open. It exposes metadata plus lazy text and outline extraction backed by PDF.js.

```ts
interface DocumentInfo {
  readonly id: string;                     // session id, unique per open tab
  readonly title: string;
  readonly path: string | null;            // filesystem path, null for in-memory documents
  readonly pageCount: number;
  readonly fingerprint: string;            // PDF.js content fingerprint, stable per file
  getPageText(pageNumber: number): Promise<string>;
  getText(): Promise<string>;              // full document text (extracts and caches per page)
  getOutline(): Promise<OutlineNode[]>;
}
```

Prefer `fingerprint` over `id` as a storage key when you want results to persist across sessions for the same file. `id` is per-tab and changes when the document is reopened.

### Plugin storage

Each plugin gets a private key/value store, namespaced by `plugin.id` and persisted across app restarts (written to the app data directory through the Tauri backend). Values are structured-clone serializable.

```ts
interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}
```

Storage is scoped so two plugins cannot read or clobber each other's data. It is meant for plugin state and small caches, not for large binary blobs.

### UI helpers

```ts
interface PluginUi {
  showToast(msg: string, opts?: { kind?: 'info' | 'success' | 'warn' | 'error'; timeout?: number }): void;
  showQuickPick<T>(items: QuickPickItem<T>[], opts?: { placeholder?: string }): Promise<T | undefined>;
  setStatusBarMessage(msg: string, timeout?: number): Disposable;
}
```

`showToast` is fire-and-forget. `showQuickPick` resolves to the chosen value or `undefined` if dismissed. `setStatusBarMessage` returns a `Disposable` so you can clear a persistent message yourself.

## Worked example: the Word Count plugin

This is a complete, self-contained plugin that registers a command, a toolbar item, and a sidebar panel, and recounts whenever a document opens. It is representative of a built-in under `src/plugins/builtins/word-count/`.

```ts
// src/plugins/builtins/word-count/index.ts
import type { FolioPlugin, PluginContext, Disposable } from '@folio/plugin-api';

interface WordCountStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  pages: number;
}

const EMPTY: WordCountStats = { words: 0, characters: 0, charactersNoSpaces: 0, pages: 0 };

function count(text: string): Omit<WordCountStats, 'pages'> {
  const trimmed = text.trim();
  return {
    words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
    characters: text.length,
    charactersNoSpaces: text.replace(/\s/g, '').length,
  };
}

let subscriptions: Disposable[] = [];
let stats: WordCountStats = EMPTY;
let render: (s: WordCountStats) => void = () => {};

const plugin: FolioPlugin = {
  id: 'com.folio.wordcount',
  name: 'Word Count',
  version: '1.0.0',

  activate(ctx: PluginContext) {
    async function recompute(): Promise<void> {
      const doc = ctx.getActiveDocument();
      if (!doc) {
        stats = EMPTY;
        render(stats);
        return;
      }
      // Serve from cache first so switching back to a document is instant.
      const cached = await ctx.storage.get<WordCountStats>(doc.fingerprint);
      if (cached) {
        stats = cached;
        render(stats);
      }
      const text = await doc.getText();
      stats = { ...count(text), pages: doc.pageCount };
      await ctx.storage.set(doc.fingerprint, stats);
      render(stats);
    }

    // 1) Command: bound to a keybinding, and invocable by AI actions or other plugins.
    subscriptions.push(
      ctx.registerCommand({
        id: 'wordcount.recount',
        title: 'Word Count: Recount Document',
        category: 'Word Count',
        keybinding: 'Ctrl+Shift+W',
        when: (c) => c.getActiveDocument() !== null,
        run: () => recompute(),
      }),
    );

    // 2) Toolbar item: clicking runs the command above (no duplicated logic).
    subscriptions.push(
      ctx.registerToolbarItem({
        id: 'wordcount.toolbar',
        commandId: 'wordcount.recount',
        icon: 'text-columns',
        tooltip: 'Recount document',
        group: 'tools',
        order: 50,
      }),
    );

    // 3) Sidebar panel: renders live stats. mount() returns a teardown callback.
    subscriptions.push(
      ctx.registerSidebarPanel({
        id: 'wordcount.panel',
        title: 'Word Count',
        icon: 'text-columns',
        order: 30,
        mount(container) {
          const dl = document.createElement('dl');
          dl.className = 'wc';
          container.appendChild(dl);

          render = (s) => {
            dl.replaceChildren(
              row('Words', s.words),
              row('Characters', s.characters),
              row('Characters (no spaces)', s.charactersNoSpaces),
              row('Pages', s.pages),
            );
          };
          render(stats);
          void recompute();

          return () => {
            render = () => {};   // stop rendering once the panel is unmounted
            dl.remove();
          };
        },
      }),
    );

    // Recount whenever a new document opens.
    subscriptions.push(ctx.onDocumentOpen(() => void recompute()));
  },

  deactivate() {
    for (const d of subscriptions) d.dispose();
    subscriptions = [];
    render = () => {};
    stats = EMPTY;
  },
};

function row(label: string, value: number): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'wc-row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value.toLocaleString();
  wrap.append(dt, dd);
  return wrap;
}

export default plugin;
```

Points worth noting in this example:

- The toolbar item and the keybinding both resolve to `wordcount.recount`. There is exactly one code path that does the work.
- The sidebar panel's `mount` returns a teardown callback, and `deactivate` disposes every subscription. Enabling and disabling the plugin at runtime leaves nothing behind.
- Results are cached in `ctx.storage` under the document `fingerprint`, so reopening the same file is instant while a fresh count runs in the background.

## How `PluginHost` loads and activates plugins

The `PluginHost` (in `src/plugins/host.ts`) owns discovery, activation, and teardown. It treats built-in and third-party plugins the same way once loaded; only discovery differs.

### Built-in plugins

Built-ins live in `src/plugins/builtins/` and are compiled into the app bundle. The host imports a static manifest of them at startup:

```ts
// src/plugins/builtins/index.ts
import wordCount from './word-count';
import pageRotation from './page-rotation';
// ...

export const builtinPlugins = [wordCount, pageRotation /* ... */];
```

Built-ins are trusted (they ship with Folio) and are enabled by default, though the user can disable any of them in the plugin manager.

### Third-party plugins

Third-party plugins are discovered at runtime from the plugins directory in the app data folder (resolved through Tauri, e.g. `~/.local/share/com.folio.app/plugins/` on Linux). Each plugin is a folder containing a `manifest.json` and a bundled entry module:

```json
{
  "id": "com.example.wordcount",
  "name": "Word Count",
  "version": "1.0.0",
  "main": "dist/index.js",
  "engines": { "folio": ">=0.1.0 <0.2.0" },
  "activationEvents": ["onStartup", "onCommand:wordcount.recount", "onDocumentOpen"],
  "permissions": ["documents:read", "storage"]
}
```

The host reads the manifest, checks compatibility against the running API version (see [Versioning](#versioning-and-compatibility)), and lazily activates the plugin when one of its `activationEvents` fires. `onStartup` activates immediately; `onCommand:<id>` defers activation until that command is first invoked, keeping cold start fast for plugins that are rarely used.

### Activation flow

```
discover -> validate manifest -> check engines.folio -> wait for activationEvent
         -> import main module -> build a PluginContext scoped to this plugin
         -> await plugin.activate(ctx)
```

On disable, uninstall, or app shutdown the host calls `plugin.deactivate()` (if present) and then disposes any `Disposable` the plugin failed to dispose itself, as a safety net. Never depend on that safety net for correctness: dispose your own resources.

## Versioning and compatibility

Two independent versions are in play:

- The plugin's own `version` (semver), which you bump on each release.
- The host plugin API version, exposed as `ctx.apiVersion` and satisfied against the plugin's `engines.folio` range.

A plugin declares the API range it supports with `engines.folio` in its manifest. The host refuses to activate a plugin whose range does not include the current `apiVersion`, and surfaces the mismatch in the plugin manager rather than failing silently. Follow standard semver expectations: the API adds capabilities in minor releases and only removes or changes them in majors. Pin conservatively (`>=0.1.0 <0.2.0`) while the API is pre-1.0 and moving.

If you contribute a command, toolbar item, sidebar panel, or annotation tool, treat its `id` as public API for your plugin. Other plugins and user keybindings may reference it.

## Security and sandboxing

Read this section before installing any third-party plugin, and before publishing one.

### The trust model today

In v0.1, plugins run in the renderer process, in the same JavaScript context as Folio's own UI. That means a plugin has the same reach as the app UI code: it can touch the DOM, call the public plugin API, and reach anything else exposed to the renderer. It does not get direct filesystem or shell access, because those live behind explicit Tauri commands in the Rust backend, but a plugin can still exfiltrate document text over the network or interfere with the UI. **Treat installing a third-party plugin as running third-party code with access to your open documents.**

Built-in plugins are trusted because they ship as part of Folio and go through the project's review process. Third-party plugins do not carry that guarantee.

### The `permissions` manifest (declared now, enforced later)

Third-party manifests already declare a `permissions` array (`documents:read`, `documents:write`, `storage`, `network`, `annotations:write`, and so on). In v0.1 these are advisory: the plugin manager shows them to the user at install time so the request is transparent, but they are not yet hard-enforced by a sandbox. Declaring the minimum set your plugin actually needs is both good manners and forward-compatible with enforcement.

### Roadmap toward isolation

The direction is capability-based isolation, enforced rather than advisory:

1. **Enforced permissions.** The host mediates `PluginContext` so an undeclared capability throws. A plugin without `network` cannot open a socket; a plugin without `documents:write` gets a read-only `DocumentInfo`.
2. **Worker isolation.** Move third-party plugin code into a dedicated Web Worker (or a sandboxed iframe) with no direct DOM or global access. The plugin talks to the host over a typed message channel, and the same `PluginContext` shape is proxied across that boundary, so the API in this guide does not change for plugin authors.
3. **Brokered UI.** Panel and toolbar rendering flows through a host-owned, sanitized surface so a plugin cannot reach into Folio's own DOM.

Because the public API is already the only supported surface, this migration is intended to be transparent for well-behaved plugins: if you only ever touch `PluginContext`, dispose what you register, and declare accurate permissions, your plugin should keep working as isolation lands.

### Guidance for users installing third-party plugins

- Install plugins only from sources you trust. A plugin can read the text of every document you open.
- Review the permissions shown at install time. A word-count plugin has no reason to request `network`.
- Keep plugins updated, and disable any plugin you are not actively using (disable is instant and reversible).
- Report suspicious plugins. Folio's plugin manager lets you disable and uninstall without restarting the app.

## `PluginContext` API reference

| Member | Kind | Signature | Returns | Purpose |
| --- | --- | --- | --- | --- |
| `apiVersion` | property | `readonly apiVersion: string` | `string` | Semver of the host plugin API, matched against `engines.folio`. |
| `registerCommand` | method | `registerCommand(cmd: Command): Disposable` | `Disposable` | Register a command in the global registry (keybinding, palette entry, dispatch target). |
| `registerToolbarItem` | method | `registerToolbarItem(item: ToolbarItem): Disposable` | `Disposable` | Add a toolbar button that runs a command. |
| `registerSidebarPanel` | method | `registerSidebarPanel(panel: SidebarPanel): Disposable` | `Disposable` | Contribute a panel to the sidebar via a `mount(container)` contract. |
| `registerAnnotationTool` | method | `registerAnnotationTool(tool: AnnotationTool): Disposable` | `Disposable` | Add a custom annotation tool that emits `AnnotationDraft`s. |
| `onDocumentOpen` | method | `onDocumentOpen(handler: (doc: DocumentInfo) => void): Disposable` | `Disposable` | Fire when a document is opened and ready. |
| `onPageRender` | method | `onPageRender(handler: (e: PageRenderEvent) => void): Disposable` | `Disposable` | Fire on each page rasterization; use for per-page overlays. |
| `getActiveDocument` | method | `getActiveDocument(): DocumentInfo \| null` | `DocumentInfo \| null` | Get the current document, or `null` if none is open. |
| `storage` | property | `storage: PluginStorage` | `PluginStorage` | Private, persisted key/value store namespaced to the plugin. |
| `ui` | property | `ui: PluginUi` | `PluginUi` | Toasts, quick picks, and status-bar messages. |

## Related documentation

- [AI & MCP integration](./ai.md): how AI actions dispatch through the same command registry your plugins use.
- [Roadmap](../ROADMAP.md): where the plugin host, annotation tools, and sandboxing sit in the release plan.
