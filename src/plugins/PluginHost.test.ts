import { afterEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';

import { useContributionStore } from './contributionStore';
import { pluginHost } from './PluginHost';
import type { DocumentInfo, FolioPlugin, PluginContext } from './types';

function makePlugin(onDoc?: (doc: DocumentInfo) => void): FolioPlugin {
  return {
    id: 'test.plugin',
    name: 'Test',
    version: '1.0.0',
    activate(ctx: PluginContext) {
      ctx.registerCommand({ id: 'test.cmd', title: 'T', run: () => {} });
      ctx.registerToolbarItem({ id: 'test.tb', title: 'T', commandId: 'test.cmd' });
      ctx.registerSidebarPanel({ id: 'test.panel', title: 'P', render: () => {} });
      if (onDoc) ctx.onDocumentOpen(onDoc);
    },
  };
}

describe('PluginHost', () => {
  afterEach(async () => {
    await pluginHost.deactivate('test.plugin');
  });

  it('activates a plugin and registers its contributions', async () => {
    await pluginHost.activate(makePlugin());

    expect(commandRegistry.has('test.cmd')).toBe(true);
    expect(useContributionStore.getState().toolbarItems.some((i) => i.id === 'test.tb')).toBe(true);
    expect(useContributionStore.getState().sidebarPanels.some((p) => p.id === 'test.panel')).toBe(
      true,
    );
    expect(pluginHost.listActive().some((p) => p.id === 'test.plugin')).toBe(true);
  });

  it('removes all contributions when deactivated', async () => {
    await pluginHost.activate(makePlugin());
    await pluginHost.deactivate('test.plugin');

    expect(commandRegistry.has('test.cmd')).toBe(false);
    expect(useContributionStore.getState().toolbarItems.some((i) => i.id === 'test.tb')).toBe(false);
    expect(useContributionStore.getState().sidebarPanels.some((p) => p.id === 'test.panel')).toBe(
      false,
    );
  });

  it('notifies document-open handlers and tracks the active document', async () => {
    const handler = vi.fn();
    await pluginHost.activate(makePlugin(handler));

    const doc: DocumentInfo = { name: 'a.pdf', numPages: 3, fingerprint: 'fp' };
    pluginHost.emitDocumentOpen(doc);

    expect(handler).toHaveBeenCalledWith(doc);
    expect(pluginHost.getActiveDocument()).toEqual(doc);
  });
});
