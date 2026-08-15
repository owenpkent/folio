import { Button, Modal, ModalProgress } from '@/components/common';

import { useOcrStore } from './store';

/** A modal progress indicator shown while OCR is recognizing pages. */
export function OcrProgressModal() {
  const status = useOcrStore((s) => s.status);
  const progress = useOcrStore((s) => s.progress);
  const requestCancel = useOcrStore((s) => s.requestCancel);
  const cancelRequested = useOcrStore((s) => s.cancelRequested);

  const open = status === 'running';
  const pct = progress.total
    ? Math.round(((progress.current - 1 + progress.page) / progress.total) * 100)
    : 0;

  return (
    <Modal
      open={open}
      title="Recognizing text (OCR)"
      // Escape stops the run, exactly as it does in the print progress dialog.
      // This modal is the one that used to have no Escape handler at all, which
      // made the dialog a user can be sitting in front of for minutes the one
      // place the app's own "Escape is the way out of any modal" rule did not
      // hold. Cancel is a request, not an abort: the loop stops at the next
      // page boundary, and the pages already recognized are kept.
      onDismiss={requestCancel}
      // The footer's Cancel is the affordance; a header X beside it would read
      // as "close this dialog and let it keep running", which is not on offer.
      showClose={false}
      dismissDisabled={cancelRequested}
      size="narrow"
    >
      <div className="folio-modal__body">
        <p aria-live="polite">
          Recognizing page {Math.min(progress.current, progress.total)} of {progress.total}…
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
