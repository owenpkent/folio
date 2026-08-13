import { useEffect, useRef } from 'react';

import { useFocusTrap } from '@/a11y/focus';
import { Button, IconButton } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { PageActionBar } from './PageActionBar';
import { PageList } from './PageList';
import { usePageOpsStore } from './store';

/** Rasterisation scale for the grid: larger than a sidebar thumb, still cheap. */
const GRID_SCALE = 0.35;

/**
 * A full-window grid of every page, for reorganising a document rather than
 * reading it.
 *
 * The sidebar can do all of this too, but one column of small thumbnails is a
 * poor place to move page 4 to page 90. This is the same {@link PageList} with
 * room to work in.
 */
export function OrganizePagesModal() {
  const open = usePageOpsStore((s) => s.organizing);
  const setOrganizing = usePageOpsStore((s) => s.setOrganizing);
  const numPages = useViewerStore((s) => s.numPages);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOrganizing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOrganizing]);

  // Closing the document while the organizer is up would leave it showing an
  // empty grid over nothing.
  useEffect(() => {
    if (open && numPages === 0) setOrganizing(false);
  }, [open, numPages, setOrganizing]);

  if (!open) return null;

  const close = () => setOrganizing(false);

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal folio-modal--wide folio-organize"
        role="dialog"
        aria-modal="true"
        aria-label="Organize pages"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">Organize pages</h2>
          <IconButton icon="x" label="Close" onClick={close} />
        </div>

        <p className="folio-modal__hint">
          Drag a page to move it. Pick out several with the checkboxes, or press Space on a page,
          then use the actions below. Ctrl+Z undoes the last change.
        </p>

        <div className="folio-modal__body folio-organize__body">
          <PageList
            layout="grid"
            scrollRoot=".folio-organize__body"
            scale={GRID_SCALE}
            rootMargin="600px 0px"
          />
        </div>

        <div className="folio-modal__footer folio-organize__footer">
          <PageActionBar />
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
