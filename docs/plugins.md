# Writing Folio Plugins

Folio is extensible. Almost everything the built-in UI does (adding a toolbar button, contributing a sidebar panel, defining an annotation tool, reacting to a document opening) is available to plugins through the same public API. Built-in features under `src/plugins/builtins/` are written against exactly the contract described here, so there is no privileged internal path that a plugin cannot reach.

This guide covers plugin anatomy and lifecycle, every contribution point on `PluginContext`, a complete worked example, how the `PluginHost` activates plugins today, storage, event hooks, versioning, and the current security model. Where a capability is on the roadmap but not yet implemented, it is called out as **Planned**.

- Command registry contract: [`src/commands`](../src/commands)
- Plugin API and host: [`src/plugins`](../src/plugins)
- Built-in plugins: [`src/plugins/builtins`](../src/plugins/builtins)

The public type surface lives in [`src/plugins/types.ts`](../src/plugins/types.ts) and is re-exported from [`src/plugins/index.ts`](../src/plugins/index.ts), so plugins import from `@/plugins`. Built-ins that live inside the plugins folder import the same types from the relative `../types`.

## Anatomy of a plugin

A plugin is an object that satisfies `FolioPlugin`. The only required members are an identity (`id`, `name`, `version`) and an `activate` function. Everything a plugin contributes is registered from inside `activate`, using the `PluginContext` it receives.

```ts
import type { FolioPlugin, PluginContext } from '@/plugins';

const plugin: FolioPlugin = {
  id: 'com.example.hello',   // reverse-DNS, globally unique, stable across versions
  name: 'Hello',             // human-readable, shown wherever Folio lists active plugins
  version: '1.0.0',          // semver of the plugin itself

  activate(ctx: PluginContext) {
    ctx.ui.showToast('Hello from a plugin'); // kind defaults to 'info'
  },
};

export default plugin;
```

### The `FolioPlugin` interface

```ts
interface FolioPlugin {
  id: string;       // reverse-DNS, e.g. "app.folio.word-count"
  name: string;
  version: string;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
```

- `id` is the identity the host keys everything on: the storage namespace (`folio.plugin.<id>.`) and the host's active-plugin map. Never change it between releases (change `version` instead).
- `activate` runs once when the plugin is activated (see [Activation](#how-pluginhost-loads-and-activates-plugins)). It may be async; the host awaits it before considering the plugin ready. If it throws, the host logs the error and immediately deactivates the plugin.
- `deactivate` is optional. The host already disposes everything you registered through the context (see below), so you only need `deactivate` for resources the context does not know about (timers, `AbortController`s, external sockets).

## Lifecycle and `Disposable` cleanup

Every `register*` and `on*` call on `PluginContext` returns a `Disposable`:

```ts
interface Disposable {
  dispose(): void;
}
```

Each of those disposables is also tracked by the host. When a plugin is deactivated the host disposes all of them for you, in reverse registration order, and then calls your optional `deactivate()`. In other words, hot enable/disable is safe without any bookkeeping on your part: a plugin that only registers contributions (like the built-in Word Count) does not need a `deactivate` at all.

Keep the returned `Disposable` only when you want to remove a single contribution *before* the plugin is torn down (for example, retiring a toolbar item when a mode changes):

```ts
import type { FolioPlugin, PluginContext, Disposable } from '@/plugins';

const plugin: FolioPlugin = {
  id: 'com.example.hello',
  name: 'Hello',
  version: '1.0.0',

  activate(ctx: PluginContext) {
    const greet: Disposable = ctx.registerCommand({
      id: 'hello.greet',
      title: 'Hello: Greet',
      run: () => ctx.ui.showToast('Hi'),
    });

    ctx.onDocumentOpen((doc) => ctx.ui.showToast(`Opened ${doc.name}`));

    // Remove just the command later, if you need to:
    // greet.dispose();
    void greet;
  },
};

export default plugin;
```

Why the host tracks disposables: Folio can deactivate a plugin without restarting the app. If a contribution or event handler were left behind, it would keep firing against a context that no longer exists. Automatic disposal on deactivate is what makes that safe. Use `deactivate` for anything the host cannot see (timers, sockets, `AbortController`s).

## Contribution points: the `PluginContext`

```ts
interface PluginContext {
  readonly pluginId: string;     // this plugin's id
  readonly apiVersion: string;   // host plugin API version, currently "0.1.0"

  registerCommand(command: Command): Disposable;
  registerToolbarItem(item: ToolbarItem): Disposable;
  registerSidebarPanel(panel: SidebarPanel): Disposable;
  registerAnnotationTool(tool: AnnotationToolDef): Disposable;

  onDocumentOpen(handler: (doc: DocumentInfo) => void): Disposable;
  onPageRender(handler: (event: PageRenderEvent) => void): Disposable;

  getActiveDocument(): DocumentInfo | null;

  storage: PluginStorage;
  ui: PluginUi;
}
```

### Commands

Commands are the single dispatch mechanism in Folio. Keyboard shortcuts, toolbar clicks, plugin actions, and AI actions all resolve to a command id and run through the global registry.

```ts
interface Command {
  id: string;                          // unique, namespaced by convention: "wordcount.recount"
  title: string;                       // human-readable label shown in menus / the command palette
  category?: string;                   // grouping label, e.g. "View"
  keybinding?: string;                 // e.g. "Mod+O" (Mod = Cmd on macOS, Ctrl elsewhere)
  when?: () => boolean;                // enablement guard, re-evaluated on each dispatch
  run(ctx?: CommandContext): void | Promise<void>;
}
```

`ctx.registerCommand(cmd)` forwards to the global `commandRegistry.register(cmd)`. Anything can then invoke it:

```ts
import { commandRegistry } from '@/commands';

await commandRegistry.execute('wordcount.recount');
await commandRegistry.execute('viewer.goToPage', { args: { page: 12 } });
```

The optional `CommandContext` passed to `run` carries an opaque payload:

```ts
interface CommandContext {
  args?: unknown; // the second argument passed to commandRegistry.execute
}
```

**Planned:** a richer `CommandContext` (typed access to the active document, viewer navigation/zoom, and the current text selection) is on the roadmap. Today `run` reads app state directly from the relevant stores, as the built-in Word Count plugin does.

Use `when` to disable a command (and its keybinding) when it cannot run. It takes no arguments and is re-evaluated on every dispatch, so it must be cheap and side-effect free. A command whose `when` returns `false` is skipped by `commandRegistry.execute`. The command palette that will also consult `when` is planned; commands, keybindings, and programmatic dispatch work today.

### Toolbar items

A toolbar item is a visual affordance that runs a command. It carries no logic of its own, which keeps behavior testable through the command registry and keeps a single source of truth for enablement (the command's `when`).

```ts
interface ToolbarItem {
  id: string;
  title: string;                       // tooltip / accessible label
  icon?: string;                       // icon name from the built-in icon set (see components/common/Icon)
  group?: 'left' | 'center' | 'right'; // which toolbar cluster the item joins
  commandId: string;                   // the command dispatched when the item is activated
}
```

Registering an item adds it to the reactive contribution store, so the toolbar shows it immediately and removes it the moment the item's `Disposable` is disposed (or the plugin deactivates).

### Sidebar panels

Sidebar panels contribute to the rail alongside Folio's built-in panels. The `render` contract is deliberately framework-free (a DOM node, not a React component) so plugins are not coupled to Folio's UI stack. You are handed a container element and return an optional cleanup function that runs on unmount.

```ts
interface SidebarPanel {
  id: string;
  title: string;
  icon?: string;
  // Render the panel body into `container`. Return an optional teardown
  // callback, called when the panel is unmounted (the plugin is deactivated,
  // or the panel is otherwise torn down).
  render(container: HTMLElement): void | (() => void);
}
```

Both built-in and third-party panels render into the container the same way: create DOM nodes and append them, or mount your own micro-framework inside `container`. The container is owned by Folio, so do not reach outside it into the rest of the DOM. See the [worked example](#worked-example-the-word-count-plugin) for a real `render` implementation.

### Annotation tools

`registerAnnotationTool` adds a tool definition to the annotation-tools contribution store. Today that definition is intentionally minimal (an id, a title, and an optional icon):

```ts
interface AnnotationToolDef {
  id: string;
  title: string;
  icon?: string;
}
```

**Planned:** the interactive drawing contract for annotation tools is a roadmap item (see the [roadmap](../ROADMAP.md) annotation-layer milestone). The intended shape is a tool that receives normalized pointer events in PDF page coordinates and returns an annotation draft on completion, which Folio would persist through the same pipeline as the built-in tools. That handler API (`onPointerDown` / `onPointerMove` / `onPointerUp`, pointer events, and draft objects) is not implemented yet; `registerAnnotationTool` currently only registers the definition above.

### Event hooks

Two document lifecycle hooks are available in v0.1. Both return a `Disposable`.

```ts
onDocumentOpen(handler: (doc: DocumentInfo) => void): Disposable;
onPageRender(handler: (event: PageRenderEvent) => void): Disposable;
```

`onDocumentOpen` fires when a document has been opened and loaded; the `DocumentInfo` handed to the handler is also cached as the active document (so `getActiveDocument()` returns it afterwards). `onPageRender` fires each time a page is rasterized to a canvas. Because it can fire many times during fast scrolling, keep the handler cheap and idempotent.

```ts
interface PageRenderEvent {
  pageNumber: number;
  scale: number; // current render scale (device pixels per PDF unit)
}
```

A minimal use of `onPageRender` today is tracking which page and zoom level are on screen:

```ts
ctx.onPageRender((event) => {
  console.debug(`rendered page ${event.pageNumber} at scale ${event.scale}`);
});
```

**Planned:** a richer `PageRenderEvent` that also exposes the page canvas, text layer, and a plugin-writable overlay layer (for drawing per-page badges, watermarks, or search-hit boxes) is on the roadmap. The current event carries only `pageNumber` and `scale`.

### The active document

`getActiveDocument()` returns a `DocumentInfo`, or `null` when no document is open.

```ts
interface DocumentInfo {
  name: string;        // display name of the document
  numPages: number;    // total page count
  fingerprint: string; // PDF.js content fingerprint, stable per file
}
```

`DocumentInfo` is metadata only. To read page text or other content, use the PDF engine directly, as the built-in Word Count plugin does:

```ts
import { getEngine } from '@/core/pdf';

const engine = getEngine();
const text = await engine.getPageText(1); // text of page 1
```

Use `fingerprint` as a stable per-file storage key when you want results to persist across sessions for the same file: it is derived from the file content, not from the session.

### Plugin storage

Each plugin gets a private key/value store, namespaced by `plugin.id` (keys are prefixed `folio.plugin.<id>.`) and persisted through the browser's `localStorage` inside the Tauri webview. The API is synchronous, and values are serialized with `JSON.stringify`, so they must be JSON-serializable.

```ts
interface PluginStorage {
  get<T = unknown>(key: string): T | null;   // null if absent or unparseable
  set<T = unknown>(key: string, value: T): void;
  remove(key: string): void;
}
```

Storage is scoped by the id prefix so two plugins do not read or clobber each other's keys. It is meant for plugin state and small caches, not for large binary blobs. `get` returns `null` (never throws) if the key is missing or the stored value cannot be parsed.

**Planned:** richer storage helpers (`keys()`, `clear()`, and a Tauri-backed store in the app data directory that survives a `localStorage` clear) are on the roadmap. The three synchronous methods above are what ships today.

### UI helpers

```ts
interface PluginUi {
  showToast(message: string, opts?: { kind?: 'info' | 'success' | 'error' }): void;
}
```

`showToast` is fire-and-forget; `kind` defaults to `'info'`. It forwards to Folio's shared toast store.

**Planned:** additional UI helpers such as a quick-pick prompt and a persistent status-bar message are on the roadmap. `showToast` is the only UI helper implemented today.

## Worked example: the Word Count plugin

This is a complete, self-contained plugin that registers a command, a toolbar button that runs it, and a live sidebar panel, and reacts when a document opens. It is the real built-in from `src/plugins/builtins/wordCount.ts`.

```ts
// src/plugins/builtins/wordCount.ts
import { getEngine } from '@/core/pdf';
import { useDocumentStore } from '@/state/documentStore';

import type { FolioPlugin, PluginContext } from '../types';

interface Stats {
  words: number;
  characters: number;
  pages: number;
}

async function computeStats(): Promise<Stats | null> {
  const { info, status } = useDocumentStore.getState();
  if (status !== 'ready' || !info) return null;

  const engine = getEngine();
  let words = 0;
  let characters = 0;
  for (let page = 1; page <= info.numPages; page++) {
    const text = await engine.getPageText(page);
    characters += text.length;
    words += text.split(/\s+/).filter(Boolean).length;
  }
  return { words, characters, pages: info.numPages };
}

// The sidebar panel renders imperatively into the container and returns a
// teardown callback. No JSX, no React: just DOM nodes.
function renderPanel(container: HTMLElement): () => void {
  let disposed = false;
  container.replaceChildren();

  const status = document.createElement('p');
  status.className = 'folio-plugin-panel__hint';
  status.textContent = 'Reading document…';
  container.appendChild(status);

  const list = document.createElement('dl');
  list.className = 'folio-stats';
  container.appendChild(list);

  const row = (label: string, value: string) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    list.append(dt, dd);
  };

  void computeStats().then((stats) => {
    if (disposed) return;
    if (!stats) {
      status.textContent = 'Open a document to see word counts.';
      return;
    }
    status.remove();
    row('Words', stats.words.toLocaleString());
    row('Characters', stats.characters.toLocaleString());
    row('Pages', stats.pages.toLocaleString());
  });

  return () => {
    disposed = true;
  };
}

export const wordCountPlugin: FolioPlugin = {
  id: 'app.folio.word-count',
  name: 'Word Count',
  version: '0.1.0',

  activate(ctx: PluginContext) {
    // 1) Command: enabled only when a document is ready; invocable by keybinding,
    //    AI actions, or other plugins through the command registry.
    ctx.registerCommand({
      id: 'plugin.wordCount.show',
      title: 'Word Count: count this document',
      category: 'Plugins',
      when: () => useDocumentStore.getState().status === 'ready',
      run: async () => {
        const stats = await computeStats();
        ctx.ui.showToast(stats ? `${stats.words.toLocaleString()} words` : 'No document open', {
          kind: stats ? 'info' : 'error',
        });
      },
    });

    // 2) Toolbar button: activates the same command from the toolbar (and
    //    collapses into the overflow menu on narrow windows like any tool).
    ctx.registerToolbarItem({
      id: 'plugin.wordCount.toolbar',
      title: 'Count this document',
      icon: 'hash',
      group: 'right',
      commandId: 'plugin.wordCount.show',
    });

    // 3) Sidebar panel: renders live stats into the container DOM node.
    ctx.registerSidebarPanel({
      id: 'app.folio.word-count.panel',
      title: 'Word Count',
      icon: 'hash',
      render: renderPanel,
    });

    // 4) React whenever a new document opens.
    ctx.onDocumentOpen(() => {
      ctx.ui.showToast('Word Count is ready for this document', { kind: 'info' });
    });
  },
};
```

Points worth noting in this example:

- The plugin registers a command, a toolbar item, and a panel, and never keeps the returned disposables: the host disposes all of them automatically on deactivate, so no `deactivate` is needed.
- The command's `when` gates enablement (`status === 'ready'`), and the command is the single code path that computes the count. The toolbar item reuses it by pointing its `commandId` at the same `id`; a keybinding would reuse it the same way.
- The sidebar panel renders imperatively into `container` and returns a teardown callback that stops the in-flight async work; this is the `render` contract, not a React component.

## How `PluginHost` loads and activates plugins

The `PluginHost` (in `src/plugins/PluginHost.ts`, exported as the app-wide singleton `pluginHost`) owns activation, teardown, and brokering the events plugins subscribe to. Built-in and (eventually) third-party plugins go through the same `activate` path.

### Built-in plugins (today)

Built-ins live in `src/plugins/builtins/` and are compiled into the app bundle. `src/plugins/builtins/index.ts` exports a static array of them:

```ts
// src/plugins/builtins/index.ts
import type { FolioPlugin } from '../types';
import { wordCountPlugin } from './wordCount';

export const builtinPlugins: FolioPlugin[] = [wordCountPlugin];
```

`activateBuiltinPlugins()` (in `src/plugins/index.ts`) iterates that array and activates each plugin. It is called once on startup from `App.tsx`:

```ts
// src/plugins/index.ts
export async function activateBuiltinPlugins(): Promise<void> {
  for (const plugin of builtinPlugins) {
    await pluginHost.activate(plugin);
  }
}
```

Built-ins are trusted (they ship with Folio) and are activated on startup. This is the only plugin-loading path that exists today.

### Activation flow (today)

```
activateBuiltinPlugins() -> for each plugin in builtinPlugins:
  pluginHost.activate(plugin)
    -> build a PluginContext scoped to plugin.id
    -> await plugin.activate(ctx)         (on throw: log and deactivate)
```

Teardown is the mirror image. `pluginHost.deactivate(id)` disposes every tracked `Disposable` in reverse registration order, then calls the plugin's optional `deactivate()`, then drops the plugin's event-handler sets. The host never depends on a plugin to clean up its own contributions; it disposes them for you.

### Third-party plugins (Planned)

> **Planned / not yet implemented.** Folio does not yet load third-party plugins. There is no manifest loader, no plugin directory discovery, no activation-events system, and no `engines` compatibility gate. Everything in this subsection describes the intended design, not shipped behavior.

The intended model is that third-party plugins are discovered at runtime from a plugins directory in the app data folder (resolved through Tauri, e.g. `~/.local/share/app.folio/plugins/` on Linux). Each plugin would be a folder containing a `manifest.json` and a bundled entry module:

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

Under that design the host would read the manifest, check compatibility against the running API version, and lazily activate the plugin when one of its `activationEvents` fired: `onStartup` immediately, `onCommand:<id>` deferred until that command is first invoked. The planned activation flow:

```
discover -> validate manifest -> check engines.folio -> wait for activationEvent
         -> import main module -> build a PluginContext scoped to this plugin
         -> await plugin.activate(ctx)
```

Because the `PluginContext` surface is deliberately narrow, the goal is that a plugin written against today's API keeps working once third-party loading lands.

## Versioning and compatibility

Two independent versions are in play:

- The plugin's own `version` (semver), which you bump on each release.
- The host plugin API version, exposed as `ctx.apiVersion`. Its value is the `FOLIO_PLUGIN_API_VERSION` constant, currently `"0.1.0"`.

Today a plugin can read `ctx.apiVersion` and decide for itself whether it is compatible. **Planned:** automatic enforcement, where a plugin declares an `engines.folio` range in its manifest and the host refuses to activate it (surfacing the mismatch rather than failing silently) if the range does not include the current `apiVersion`. That gate depends on the third-party manifest loader described above and is not implemented yet. Either way, follow standard semver expectations: the API adds capabilities in minor releases and only removes or changes them in majors. Pin conservatively (`>=0.1.0 <0.2.0`) while the API is pre-1.0 and moving.

If you contribute a command, toolbar item, sidebar panel, or annotation tool, treat its `id` as public API for your plugin. Other plugins and user keybindings may reference it.

## Security and sandboxing

### The trust model today

Today Folio runs only its own built-in, first-party plugins, and they run in the renderer process, in the same JavaScript context as Folio's UI. A plugin therefore has the same reach as the app UI code: it can touch the DOM, call the public plugin API, and reach anything else exposed to the renderer. It does not get direct filesystem or shell access, because those live behind explicit Tauri commands in the Rust backend, but code running in the renderer could still read document text or interfere with the UI.

Built-in plugins are trusted because they ship as part of Folio and go through the project's review process. There is no third-party install path yet, so there is no untrusted plugin code running today. The remainder of this section describes the roadmap for when third-party plugins are supported.

### The `permissions` manifest (Planned)

> **Planned / not yet implemented.**

The intended design gives each third-party manifest a `permissions` array (`documents:read`, `documents:write`, `storage`, `network`, `annotations:write`, and so on). In the first phase these would be advisory: the plugin manager shows them to the user at install time so the request is transparent, before they are hard-enforced by a sandbox. Declaring the minimum set a plugin actually needs is both good manners and forward-compatible with enforcement. None of this is wired up yet; no manifest is read today.

### Roadmap toward isolation (Planned)

The direction is capability-based isolation, enforced rather than advisory:

1. **Enforced permissions.** The host mediates `PluginContext` so an undeclared capability throws. A plugin without `network` cannot open a socket; a plugin without `documents:write` gets a read-only `DocumentInfo`.
2. **Worker isolation.** Move third-party plugin code into a dedicated Web Worker (or a sandboxed iframe) with no direct DOM or global access. The plugin talks to the host over a typed message channel, and the same `PluginContext` shape is proxied across that boundary, so the API in this guide does not change for plugin authors.
3. **Brokered UI.** Panel and toolbar rendering flows through a host-owned, sanitized surface so a plugin cannot reach into Folio's own DOM.

Because the public API is already the only supported surface, this migration is intended to be transparent for well-behaved plugins: if you only ever touch `PluginContext`, let the host dispose what you register, and (in future) declare accurate permissions, your plugin should keep working as isolation lands.

### Guidance for users installing third-party plugins (Planned)

> Applies once third-party plugins are supported; there is no install path today.

- Install plugins only from sources you trust. A plugin can read the text of every document you open.
- Review the permissions shown at install time. A word-count plugin has no reason to request `network`.
- Keep plugins updated, and disable any plugin you are not actively using.
- Report suspicious plugins.

## `PluginContext` API reference

| Member | Kind | Signature | Returns | Purpose |
| --- | --- | --- | --- | --- |
| `pluginId` | property | `readonly pluginId: string` | `string` | This plugin's id; also the prefix for its storage namespace. |
| `apiVersion` | property | `readonly apiVersion: string` | `string` | Host plugin API version (`FOLIO_PLUGIN_API_VERSION`), currently `"0.1.0"`. Read it to check compatibility. |
| `registerCommand` | method | `registerCommand(command: Command): Disposable` | `Disposable` | Register a command in the global registry (keybinding, dispatch target, future palette entry). |
| `registerToolbarItem` | method | `registerToolbarItem(item: ToolbarItem): Disposable` | `Disposable` | Add a toolbar button that dispatches a command by id. |
| `registerSidebarPanel` | method | `registerSidebarPanel(panel: SidebarPanel): Disposable` | `Disposable` | Contribute a panel to the sidebar via a `render(container)` contract. |
| `registerAnnotationTool` | method | `registerAnnotationTool(tool: AnnotationToolDef): Disposable` | `Disposable` | Register an annotation tool definition (id/title/icon). Interaction API is planned. |
| `onDocumentOpen` | method | `onDocumentOpen(handler: (doc: DocumentInfo) => void): Disposable` | `Disposable` | Fire when a document is opened and loaded. |
| `onPageRender` | method | `onPageRender(handler: (event: PageRenderEvent) => void): Disposable` | `Disposable` | Fire on each page rasterization (carries `pageNumber` and `scale`). |
| `getActiveDocument` | method | `getActiveDocument(): DocumentInfo \| null` | `DocumentInfo \| null` | Get the current document, or `null` if none is open. |
| `storage` | property | `storage: PluginStorage` | `PluginStorage` | Private, synchronous, `localStorage`-backed key/value store namespaced to the plugin. |
| `ui` | property | `ui: PluginUi` | `PluginUi` | UI helpers; today just `showToast`. |

## Related documentation

- [AI & MCP integration](./ai.md): how AI actions dispatch through the same command registry your plugins use.
- [Roadmap](../ROADMAP.md): where the plugin host, annotation tools, third-party loading, and sandboxing sit in the release plan.
