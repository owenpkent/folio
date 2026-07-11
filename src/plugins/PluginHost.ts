import { commandRegistry } from '@/commands';
import { pushToast } from '@/components/common/toastStore';

import { useContributionStore } from './contributionStore';
import {
  FOLIO_PLUGIN_API_VERSION,
  type Disposable,
  type DocumentInfo,
  type FolioPlugin,
  type PageRenderEvent,
  type PluginContext,
  type PluginStorage,
} from './types';

interface ActivePlugin {
  plugin: FolioPlugin;
  disposables: Disposable[];
}

/**
 * Loads, activates, and tears down plugins, and brokers the events they
 * subscribe to. Built-in and (eventually) third-party plugins go through the
 * same path. See docs/plugins.md.
 *
 * Today plugins run in the renderer with full trust. The roadmap moves
 * third-party plugins into an isolated worker with an explicit permission
 * grant; the {@link PluginContext} surface is deliberately narrow to make that
 * transition possible without breaking plugins.
 */
class PluginHost {
  private active = new Map<string, ActivePlugin>();
  private docHandlers = new Map<string, Set<(doc: DocumentInfo) => void>>();
  private pageHandlers = new Map<string, Set<(event: PageRenderEvent) => void>>();
  private activeDoc: DocumentInfo | null = null;

  async activate(plugin: FolioPlugin): Promise<void> {
    if (this.active.has(plugin.id)) return;
    const disposables: Disposable[] = [];
    this.active.set(plugin.id, { plugin, disposables });
    try {
      await plugin.activate(this.createContext(plugin.id, disposables));
    } catch (error) {
      console.error(`[folio] plugin "${plugin.id}" failed to activate`, error);
      await this.deactivate(plugin.id);
    }
  }

  async deactivate(id: string): Promise<void> {
    const entry = this.active.get(id);
    if (!entry) return;
    for (const disposable of [...entry.disposables].reverse()) {
      try {
        disposable.dispose();
      } catch (error) {
        console.error(`[folio] error disposing a contribution from "${id}"`, error);
      }
    }
    try {
      await entry.plugin.deactivate?.();
    } catch (error) {
      console.error(`[folio] plugin "${id}" threw during deactivate`, error);
    }
    this.active.delete(id);
    this.docHandlers.delete(id);
    this.pageHandlers.delete(id);
  }

  listActive(): FolioPlugin[] {
    return [...this.active.values()].map((entry) => entry.plugin);
  }

  emitDocumentOpen(doc: DocumentInfo): void {
    this.activeDoc = doc;
    for (const handlers of this.docHandlers.values()) {
      for (const handler of handlers) safe(() => handler(doc));
    }
  }

  emitPageRender(event: PageRenderEvent): void {
    for (const handlers of this.pageHandlers.values()) {
      for (const handler of handlers) safe(() => handler(event));
    }
  }

  getActiveDocument(): DocumentInfo | null {
    return this.activeDoc;
  }

  private createContext(pluginId: string, disposables: Disposable[]): PluginContext {
    const track = (dispose: () => void): Disposable => {
      const disposable: Disposable = { dispose };
      disposables.push(disposable);
      return disposable;
    };
    const contrib = () => useContributionStore.getState();

    return {
      pluginId,
      apiVersion: FOLIO_PLUGIN_API_VERSION,

      registerCommand: (command) => track(commandRegistry.register(command)),
      registerToolbarItem: (item) => {
        contrib().addToolbarItem(item);
        return track(() => contrib().removeToolbarItem(item.id));
      },
      registerSidebarPanel: (panel) => {
        contrib().addSidebarPanel(panel);
        return track(() => contrib().removeSidebarPanel(panel.id));
      },
      registerAnnotationTool: (tool) => {
        contrib().addAnnotationTool(tool);
        return track(() => contrib().removeAnnotationTool(tool.id));
      },
      onDocumentOpen: (handler) => {
        const set = this.docHandlers.get(pluginId) ?? new Set();
        set.add(handler);
        this.docHandlers.set(pluginId, set);
        return track(() => set.delete(handler));
      },
      onPageRender: (handler) => {
        const set = this.pageHandlers.get(pluginId) ?? new Set();
        set.add(handler);
        this.pageHandlers.set(pluginId, set);
        return track(() => set.delete(handler));
      },
      getActiveDocument: () => this.activeDoc,
      storage: createPluginStorage(pluginId),
      ui: { showToast: (message, opts) => pushToast(message, opts?.kind ?? 'info') },
    };
  }
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error('[folio] plugin event handler threw', error);
  }
}

function createPluginStorage(pluginId: string): PluginStorage {
  const prefix = `folio.plugin.${pluginId}.`;
  return {
    get(key) {
      try {
        const raw = localStorage.getItem(prefix + key);
        return raw == null ? null : JSON.parse(raw);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      } catch {
        /* storage unavailable; ignore */
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(prefix + key);
      } catch {
        /* ignore */
      }
    },
  };
}

/** The single, app-wide plugin host. */
export const pluginHost = new PluginHost();
