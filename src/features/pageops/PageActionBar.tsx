import { Button } from '@/components/common';
import {
  DOCUMENT_MUTATION_BUSY_TITLE,
  useDocumentMutationStore,
} from '@/state/documentMutationStore';
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
  const localBusy = usePageOpsStore((s) => s.busy);
  // Some OTHER feature (text edit, image edit, combine, save, OCR...) is
  // mid-flight rewriting the document; every button here has to wait for it
  // the same way it already waits for a page op of its own. See
  // documentMutationStore.ts.
  const crossBusy = useDocumentMutationStore((s) => s.inFlight);
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
      {count > 0 && (
        <PageActionBarContent
          selection={selection}
          localBusy={localBusy}
          crossBusy={crossBusy}
          numPages={numPages}
        />
      )}
    </>
  );
}

interface PageActionBarContentProps {
  selection: ReadonlySet<number>;
  localBusy: boolean;
  crossBusy: boolean;
  numPages: number;
}

function PageActionBarContent({
  selection,
  localBusy,
  crossBusy,
  numPages,
}: PageActionBarContentProps) {
  const count = selection.size;
  // Deleting every page would leave no document, so the last page stays put.
  const canDelete = count < numPages;
  // Nudging past either end of the document is a no-op. Disabling the button
  // for it matches how Delete already handles "there is nothing this can do
  // right now" instead of leaving it clickable for no effect.
  const { min, max } = selectionExtent(selection);
  const atTop = min === 1;
  const atBottom = max === numPages;
  // Every button that actually rewrites the document waits on both busy
  // flags; Clear below does not, since changing the selection touches
  // nothing outside this store and is safe no matter what else is running.
  const busy = localBusy || crossBusy;
  // The cross-feature reason takes priority over a button's own structural
  // reason when both apply: it is the transient one, and the one the user is
  // least likely to already know about.
  const busyTitle = crossBusy ? DOCUMENT_MUTATION_BUSY_TITLE : undefined;

  return (
    <div className="folio-page-actions" role="group" aria-label="Actions for the selected pages">
      {/* Plain text, not a second live region: the always-mounted one above
          already owns announcing this. aria-hidden so it is not *also* a
          second static-text copy of the same information in the
          accessibility tree -- two nodes carrying identical text is worse
          than what it replaces, not just redundant with it: a screen reader
          user tabbing into this group would hit the count twice, once from
          the announcement and once as this paragraph's own content. */}
      <p className="folio-page-actions__count" aria-hidden="true">
        {count} {count === 1 ? 'page' : 'pages'} selected
      </p>
      <div className="folio-page-actions__buttons">
        <Button
          onClick={() => void nudgeSelection(-1)}
          disabled={busy || atTop}
          title={busyTitle ?? (atTop ? 'Already at the start of the document.' : undefined)}
        >
          Move up
        </Button>
        <Button
          onClick={() => void nudgeSelection(1)}
          disabled={busy || atBottom}
          title={busyTitle ?? (atBottom ? 'Already at the end of the document.' : undefined)}
        >
          Move down
        </Button>
        <Button onClick={() => void rotateSelection(-1)} disabled={busy} title={busyTitle}>
          Rotate left
        </Button>
        <Button onClick={() => void rotateSelection(1)} disabled={busy} title={busyTitle}>
          Rotate right
        </Button>
        <Button
          onClick={() => void deleteSelectedPages()}
          disabled={busy || !canDelete}
          title={busyTitle ?? (canDelete ? undefined : 'A document has to keep at least one page.')}
        >
          Delete
        </Button>
        <Button onClick={() => usePageOpsStore.getState().clearSelection()} disabled={localBusy}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/**
 * The lowest and highest page number in the selection. A loop rather than
 * `Math.min(...selection)`: spreading a selection with enough pages into a
 * function call risks the engine's own argument-count limit, which a plain
 * loop has no version of.
 */
function selectionExtent(selection: ReadonlySet<number>): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const page of selection) {
    if (page < min) min = page;
    if (page > max) max = page;
  }
  return { min, max };
}
