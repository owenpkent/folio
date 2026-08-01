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

/**
 * A small built-in plugin that demonstrates the plugin API: it contributes a
 * command and a toolbar item that runs it (which the menu bar surfaces under
 * Tools), and reacts to a document opening.
 *
 * It used to contribute a sidebar panel too, which put a permanent Word Count
 * tab in the left rail next to Thumbnails and Outline. That is a lot of
 * standing furniture for a demo, so the stats now come from the command's
 * toast. `registerSidebarPanel` is still part of the plugin API; see
 * docs/plugins.md.
 */
export const wordCountPlugin: FolioPlugin = {
  id: 'app.folio.word-count',
  name: 'Word Count',
  version: '0.1.0',

  activate(ctx: PluginContext) {
    ctx.registerCommand({
      id: 'plugin.wordCount.show',
      title: 'Word Count: count this document',
      category: 'Plugins',
      when: () => useDocumentStore.getState().status === 'ready',
      run: async () => {
        const stats = await computeStats();
        // The characters and pages counts used to live in the sidebar panel;
        // with that gone the toast is the only place they can surface.
        ctx.ui.showToast(
          stats
            ? `${stats.words.toLocaleString()} words · ${stats.characters.toLocaleString()} characters · ${stats.pages.toLocaleString()} pages`
            : 'No document open',
          { kind: stats ? 'info' : 'error' },
        );
      },
    });

    ctx.registerToolbarItem({
      id: 'plugin.wordCount.toolbar',
      title: 'Count this document',
      icon: 'hash',
      group: 'right',
      commandId: 'plugin.wordCount.show',
    });

    ctx.onDocumentOpen(() => {
      ctx.ui.showToast('Word Count is ready for this document', { kind: 'info' });
    });
  },
};
