import { commandRegistry } from '@/commands';
import { useTextEditStore } from '@/features/textedit/store';
import { documentMutationBlocked } from '@/state/documentMutationStore';
import { useDocumentStore } from '@/state/documentStore';
import { useViewerStore } from '@/state/viewerStore';

import { deleteSelectedPages, nudgeSelection, rotateSelection, undoPageOp } from './operations';
import { usePageOpsStore } from './store';

const ready = () => useDocumentStore.getState().status === 'ready';
/** Ready, not already part-way through rewriting the file, and not blocked
 *  by some OTHER feature doing the same (see documentMutationStore.ts). */
const idle = () =>
  ready() && !usePageOpsStore.getState().busy && !documentMutationBlocked('pageops', 'pages');
const hasSelection = () => idle() && usePageOpsStore.getState().selection.size > 0;
/** hasSelection, and the selection is not the whole document — deleting that would leave none. */
const canDelete = () =>
  hasSelection() && usePageOpsStore.getState().selection.size < useViewerStore.getState().numPages;

let registered = false;

/** Register the page operation commands. Idempotent. */
export function registerPageOpsCommands(): void {
  if (registered) return;
  registered = true;

  commandRegistry.register({
    id: 'pageops.organize',
    title: 'Organize pages…',
    category: 'Pages',
    when: ready,
    run: () => usePageOpsStore.getState().setOrganizing(true),
  });

  commandRegistry.register({
    id: 'pageops.delete',
    title: 'Delete selected pages',
    category: 'Pages',
    // No keybinding: Delete belongs to whichever page list has focus, and a
    // global binding would fire while the caret sat in a form field.
    when: canDelete,
    run: deleteSelectedPages,
  });

  commandRegistry.register({
    id: 'pageops.moveUp',
    title: 'Move pages up',
    category: 'Pages',
    keybinding: 'Alt+ArrowUp',
    when: hasSelection,
    run: () => nudgeSelection(-1),
  });

  commandRegistry.register({
    id: 'pageops.moveDown',
    title: 'Move pages down',
    category: 'Pages',
    keybinding: 'Alt+ArrowDown',
    when: hasSelection,
    run: () => nudgeSelection(1),
  });

  commandRegistry.register({
    id: 'pageops.rotateLeft',
    title: 'Rotate pages left',
    category: 'Pages',
    keybinding: 'Mod+[',
    when: hasSelection,
    run: () => rotateSelection(-1),
  });

  commandRegistry.register({
    id: 'pageops.rotateRight',
    title: 'Rotate pages right',
    category: 'Pages',
    keybinding: 'Mod+]',
    when: hasSelection,
    run: () => rotateSelection(1),
  });

  commandRegistry.register({
    id: 'pageops.selectAll',
    title: 'Select all pages',
    category: 'Pages',
    // Only while the organizer is up: everywhere else Mod+A means "select the
    // text on this page", which is what the browser already does.
    keybinding: 'Mod+a',
    when: () => ready() && usePageOpsStore.getState().organizing,
    run: () => usePageOpsStore.getState().selectAll(useViewerStore.getState().numPages),
  });

  commandRegistry.register({
    id: 'pageops.undo',
    title: 'Undo page change',
    category: 'Pages',
    keybinding: 'Mod+z',
    // Shares its chord with textedit.undo, which only claims it while the text
    // tool is on; the dispatcher walks past a command whose `when` says no.
    when: () =>
      idle() &&
      !useTextEditStore.getState().active &&
      usePageOpsStore.getState().undoStack.length > 0,
    run: async () => {
      await undoPageOp();
    },
  });
}
