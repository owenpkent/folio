import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { useAnnotationStore } from './store';
import { DEFAULT_HIGHLIGHT_COLOR, type NormalizedRect } from './types';

/**
 * Create a highlight from the current text selection. Client rects from the
 * selection Range are converted to page-relative fractions so the highlight is
 * zoom-independent.
 */
export function addHighlightFromSelection(color: string = DEFAULT_HIGHLIGHT_COLOR): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    announce('Select some text first, then add a highlight', true);
    return;
  }

  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startEl = startNode instanceof HTMLElement ? startNode : startNode.parentElement;
  const pageEl = startEl?.closest<HTMLElement>('.folio-page');
  if (!pageEl) return;

  const pageNumber = Number(pageEl.dataset.pageNumber);
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return;

  const pageRect = pageEl.getBoundingClientRect();
  const rects: NormalizedRect[] = Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      width: r.width / pageRect.width,
      height: r.height / pageRect.height,
    }));
  if (rects.length === 0) return;

  const text = selection.toString().replace(/\s+/g, ' ').trim();
  useAnnotationStore.getState().addHighlight(pageNumber, rects, text, color);
  selection.removeAllRanges();
  announce('Highlight added');
}

let registered = false;

/** Register annotation commands. Idempotent. */
export function registerAnnotationCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'annotate.highlight',
    title: 'Highlight selection',
    category: 'Annotate',
    keybinding: 'Mod+Shift+H',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => addHighlightFromSelection(),
  });
}
