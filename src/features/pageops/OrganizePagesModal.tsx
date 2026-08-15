import { useEffect } from 'react';

import { Button, Modal } from '@/components/common';
import { useViewerStore } from '@/state/viewerStore';

import { PageActionBar } from './PageActionBar';
import { PageList } from './PageList';
import { usePageOpsStore } from './store';

/**
 * Rasterisation scale for the grid: larger than a sidebar thumb, still cheap.
 * Matched to `.folio-page-grid .folio-thumb__frame`'s width in global.css --
 * on a US Letter page that is roughly 612 * 0.35 =~ 210px of backing store
 * for a 210px frame, rather than rasterising bytes only to downscale them
 * straight back out again.
 */
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

  const close = () => setOrganizing(false);

  // Closing the document while the organizer is up would leave it showing an
  // empty grid over nothing.
  useEffect(() => {
    if (open && numPages === 0) setOrganizing(false);
  }, [open, numPages, setOrganizing]);

  return (
    <Modal
      open={open}
      title="Organize pages"
      onDismiss={close}
      size="wide"
      className="folio-organize"
    >
      <p className="folio-modal__hint">
        Drag a page to move it. Pick out several with the checkboxes, or press Space on a page, then
        use the actions below. Ctrl+Z undoes the last change.
      </p>

      <div className="folio-modal__body folio-organize__body">
        <PageList
          layout="grid"
          scrollRoot=".folio-organize__body"
          scale={GRID_SCALE}
          rootMargin="600px 0px"
          // A plain click means "take me there": without this the viewer
          // navigates behind the still-open modal and nothing closes,
          // leaving the click looking like it did nothing at all.
          onNavigate={close}
        />
      </div>

      <div className="folio-modal__footer folio-organize__footer">
        <PageActionBar />
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
