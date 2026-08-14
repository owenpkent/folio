import { Button } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { deleteSelectedPages, nudgeSelection, rotateSelection } from './operations';
import { usePageOpsStore } from './store';

/**
 * What you can do to the pages you have picked out.
 *
 * The bar itself appears only with a selection, so the page lists stay
 * uncluttered while someone is just reading. The move buttons are also the
 * only way to reorder by touch, where dragging belongs to scrolling (see
 * usePageDrag).
 */
export function PageActionBar() {
  const selection = usePageOpsStore((s) => s.selection);
  const busy = usePageOpsStore((s) => s.busy);
  const numPages = useViewerStore((s) => s.numPages);

  const count = selection.size;
  const countText = count > 0 ? `${count} ${count === 1 ? 'page' : 'pages'} selected` : '';

  return (
    <>
      {/*
       * A live region has to already exist in the DOM before its content
       * changes for most screen readers to announce the change. Nesting this
       * inside the bar below, which mounts and unmounts with the selection,
       * meant the region was created with the count already on it every time
       * the selection went from empty to non-empty (and again, back to empty,
       * on Clear) -- exactly the transitions worth announcing, and silently.
       * Keeping one instance mounted for the component's whole lifetime, and
       * only ever changing its text, is what actually gets announced.
       */}
      <p className="folio-sr-only" role="status">
        {countText}
      </p>
      {count > 0 && <PageActionBarContent selection={selection} busy={busy} numPages={numPages} />}
    </>
  );
}

interface PageActionBarContentProps {
  selection: ReadonlySet<number>;
  busy: boolean;
  numPages: number;
}

function PageActionBarContent({ selection, busy, numPages }: PageActionBarContentProps) {
  const count = selection.size;
  // Deleting every page would leave no document, so the last page stays put.
  const canDelete = count < numPages;
  // Nudging past either end of the document is a no-op. Disabling the button
  // for it matches how Delete already handles "there is nothing this can do
  // right now" instead of leaving it clickable for no effect.
  const atTop = Math.min(...selection) === 1;
  const atBottom = Math.max(...selection) === numPages;

  return (
    <div className="folio-page-actions" role="group" aria-label="Actions for the selected pages">
      {/* Plain text, not a second live region: the always-mounted one above
          already owns announcing this. */}
      <p className="folio-page-actions__count">
        {count} {count === 1 ? 'page' : 'pages'} selected
      </p>
      <div className="folio-page-actions__buttons">
        <Button
          onClick={() => void nudgeSelection(-1)}
          disabled={busy || atTop}
          title={atTop ? 'Already at the start of the document.' : undefined}
        >
          Move up
        </Button>
        <Button
          onClick={() => void nudgeSelection(1)}
          disabled={busy || atBottom}
          title={atBottom ? 'Already at the end of the document.' : undefined}
        >
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
