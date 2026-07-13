import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { NOTE_COLOR, useNotesUi } from './notesUi';
import { useAnnotationStore } from './store';
import { DEFAULT_HIGHLIGHT_COLOR, type NormalizedRect } from './types';

/**
 * Anchor a comment to the current text selection: stores the selected text (what
 * the note refers to) and its line rects (to underline it). Returns false if
 * there is no usable selection, so the caller can fall back to point placement.
 */
export function addNoteFromSelection(color: string = NOTE_COLOR): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;

  const range = selection.getRangeAt(0);
  const startNode = range.startContainer;
  const startEl = startNode instanceof HTMLElement ? startNode : startNode.parentElement;
  const pageEl = startEl?.closest<HTMLElement>('.folio-page');
  if (!pageEl) return false;

  const pageNumber = Number(pageEl.dataset.pageNumber);
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return false;

  const pageRect = pageEl.getBoundingClientRect();
  const rects: NormalizedRect[] = Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({
      x: (r.left - pageRect.left) / pageRect.width,
      y: (r.top - pageRect.top) / pageRect.height,
      width: r.width / pageRect.width,
      height: r.height / pageRect.height,
    }));
  if (rects.length === 0) return false;

  const text = selection.toString().replace(/\s+/g, ' ').trim();
  // Pin sits at the start of the referenced text.
  const anchor = { x: rects[0].x, y: rects[0].y };
  const note = useAnnotationStore.getState().addNote(pageNumber, anchor, text, color, rects);
  selection.removeAllRanges();

  const ui = useNotesUi.getState();
  ui.setAdding(false);
  ui.setActive(note.id);
  announce('Comment added on the selected text');
  return true;
}

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

  commandRegistry.register({
    id: 'annotate.addNote',
    title: 'Add a sticky note',
    category: 'Annotate',
    keybinding: 'Mod+Shift+M',
    when: () => useDocumentStore.getState().status === 'ready',
    run: () => {
      // If text is selected, anchor the comment to it. Otherwise enter
      // point-placement mode (for figures/images with no selectable text).
      if (addNoteFromSelection()) return;
      useNotesUi.getState().toggleAdding();
      const adding = useNotesUi.getState().adding;
      announce(
        adding
          ? 'Select text to comment on it, or click a spot on the page to place a note'
          : 'Note placement cancelled',
      );
    },
  });
}
