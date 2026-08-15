import { Button, Modal, ModalProgress } from '@/components/common';

import { usePrintStore } from './store';

/**
 * How coarsely progress is announced, in percent. A live region that updated on
 * every rasterized page would queue one announcement per page: on a 500-page
 * document the screen reader is still reading "page 40" long after the print
 * dialog has opened. Ten steps is enough to tell that something is happening;
 * the progressbar below carries the exact value for anyone who wants it.
 */
const ANNOUNCE_STEP_PCT = 10;

/** Progress shown while pages are rasterized for the printer. */
export function PrintProgressModal() {
  const status = usePrintStore((s) => s.status);
  const progress = usePrintStore((s) => s.progress);
  const requestCancel = usePrintStore((s) => s.requestCancel);
  const cancelRequested = usePrintStore((s) => s.cancelRequested);

  const open = status === 'preparing';
  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;
  const announced = Math.floor(pct / ANNOUNCE_STEP_PCT) * ANNOUNCE_STEP_PCT;

  return (
    <Modal
      open={open}
      title="Preparing to print"
      // Escape is the expected way out of any modal in this app, and this one
      // is in front of the user for as long as a long document takes to
      // rasterize. Inert once a cancel has already been asked for, so a second
      // press does not queue a second request against a run that is stopping.
      onDismiss={requestCancel}
      // See OcrProgressModal: the footer's Cancel is the affordance, and a
      // header X would promise a way to dismiss this and leave it running.
      showClose={false}
      dismissDisabled={cancelRequested}
      size="narrow"
    >
      <div className="folio-modal__body">
        <p>
          {progress.total
            ? `Rendering page ${Math.min(progress.current, progress.total)} of ${progress.total}…`
            : 'Applying your edits…'}
        </p>
        {/* Separate from the line above so the text can update per page while
            the announcement only changes once per ANNOUNCE_STEP_PCT. */}
        <p className="folio-sr-only" aria-live="polite">
          {progress.total ? `Preparing to print, ${announced}% done` : 'Applying your edits'}
        </p>
        <ModalProgress percent={pct} />
      </div>
      <div className="folio-modal__footer">
        <Button onClick={() => requestCancel()} disabled={cancelRequested}>
          {cancelRequested ? 'Stopping…' : 'Cancel'}
        </Button>
      </div>
    </Modal>
  );
}
