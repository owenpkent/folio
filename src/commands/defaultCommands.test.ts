import { beforeEach, describe, expect, it } from 'vitest';

import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { commandRegistry } from './registry';
import { registerDefaultCommands } from './defaultCommands';

describe('default commands', () => {
  beforeEach(() => {
    registerDefaultCommands();
    useDocumentStore.getState().reset();
    useViewerStore.getState().reset();
  });

  it('registers the core command set', () => {
    for (const id of [
      'file.open',
      'file.close',
      'view.zoomIn',
      'view.zoomOut',
      'view.fitWidth',
      'nav.nextPage',
      'nav.prevPage',
      'search.toggle',
      'theme.toggle',
    ]) {
      expect(commandRegistry.has(id)).toBe(true);
    }
  });

  it('gates document commands until a document is ready', async () => {
    const before = useViewerStore.getState().scale;

    // No document: the guard blocks execution.
    await commandRegistry.execute('view.zoomIn');
    expect(useViewerStore.getState().scale).toBe(before);

    // With a document: it runs.
    useDocumentStore
      .getState()
      .setLoaded({ numPages: 3, fingerprint: 'f', name: 'a.pdf' }, { pageCount: 3 }, []);
    await commandRegistry.execute('view.zoomIn');
    expect(useViewerStore.getState().scale).toBeGreaterThan(before);
  });
});
