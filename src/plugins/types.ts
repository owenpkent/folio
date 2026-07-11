import type { Command } from '@/commands';

/** The plugin API version. Plugins can check `ctx.apiVersion` for compatibility. */
export const FOLIO_PLUGIN_API_VERSION = '0.1.0';

/** Something that can be torn down. Returned by every `register*` call. */
export interface Disposable {
  dispose(): void;
}

export interface DocumentInfo {
  name: string;
  numPages: number;
  fingerprint: string;
}

export interface PageRenderEvent {
  pageNumber: number;
  scale: number;
}

export type ToolbarGroup = 'left' | 'center' | 'right';

export interface ToolbarItem {
  id: string;
  title: string;
  /** Icon name from the built-in icon set (see components/common/Icon). */
  icon?: string;
  group?: ToolbarGroup;
  /** Command dispatched when the item is activated. */
  commandId: string;
}

export interface SidebarPanel {
  id: string;
  title: string;
  icon?: string;
  /**
   * Render the panel body into `container`. Kept intentionally framework-free
   * (a DOM node, not React) so plugins are not coupled to Folio's UI stack.
   * Return an optional cleanup function.
   */
  render(container: HTMLElement): void | (() => void);
}

export interface AnnotationToolDef {
  id: string;
  title: string;
  icon?: string;
}

/** Persisted key/value storage, namespaced per plugin. */
export interface PluginStorage {
  get<T = unknown>(key: string): T | null;
  set<T = unknown>(key: string, value: T): void;
  remove(key: string): void;
}

export interface PluginUi {
  showToast(message: string, opts?: { kind?: 'info' | 'success' | 'error' }): void;
}

/** The surface handed to a plugin's `activate`. */
export interface PluginContext {
  readonly pluginId: string;
  readonly apiVersion: string;
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

export interface FolioPlugin {
  /** Reverse-DNS id, e.g. "app.folio.word-count". */
  id: string;
  name: string;
  version: string;
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
