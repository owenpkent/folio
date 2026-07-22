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

/**
 * A small built-in plugin that demonstrates the plugin API: it contributes a
 * command, a toolbar button that runs it, and a live sidebar panel, and
 * recomputes when a document opens.
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
        ctx.ui.showToast(stats ? `${stats.words.toLocaleString()} words` : 'No document open', {
          kind: stats ? 'info' : 'error',
        });
      },
    });

    ctx.registerToolbarItem({
      id: 'plugin.wordCount.toolbar',
      title: 'Count this document',
      icon: 'hash',
      group: 'right',
      commandId: 'plugin.wordCount.show',
    });

    ctx.registerSidebarPanel({
      id: 'app.folio.word-count.panel',
      title: 'Word Count',
      icon: 'hash',
      render: renderPanel,
    });

    ctx.onDocumentOpen(() => {
      ctx.ui.showToast('Word Count is ready for this document', { kind: 'info' });
    });
  },
};
