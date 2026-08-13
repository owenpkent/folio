import { Button } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { deleteSelectedPages, nudgeSelection, rotateSelection } from './operations';
import { usePageOpsStore } from './store';

/**
 * What you can do to the pages you have picked out.
 *
 * Appears only with a selection, so the page lists stay uncluttered while
 * someone is just reading. The move buttons are also the only way to reorder by
 * touch, where dragging belongs to scrolling (see usePageDrag).
 */
export function PageActionBar() {
  const count = usePageOpsStore((s) => s.selection.size);
  const busy = usePageOpsStore((s) => s.busy);
  const numPages = useViewerStore((s) => s.numPages);

  if (count === 0) return null;

  // Deleting every page would leave no document, so the last page stays put.
  const canDelete = count < numPages;

  return (
    <div className="folio-page-actions" role="group" aria-label="Actions for the selected pages">
      <p className="folio-page-actions__count" role="status">
        {count} {count === 1 ? 'page' : 'pages'} selected
      </p>
      <div className="folio-page-actions__buttons">
        <Button onClick={() => void nudgeSelection(-1)} disabled={busy}>
          Move up
        </Button>
        <Button onClick={() => void nudgeSelection(1)} disabled={busy}>
          Move down
        </Button>
        <Button onClick={() => void rotateSelection(-1)} disabled={busy}>
          Rotate left
        </Button>
        <Button onClick={() => void rotateSelection(1)} disabled={busy}>
          Rotate right
        </Button>
        <Button
          onClick={() => void deleteSelectedPages()}
          disabled={busy || !canDelete}
          title={canDelete ? undefined : 'A document has to keep at least one page.'}
        >
          Delete
        </Button>
        <Button onClick={() => usePageOpsStore.getState().clearSelection()} disabled={busy}>
          Clear
        </Button>
      </div>
    </div>
  );
}
