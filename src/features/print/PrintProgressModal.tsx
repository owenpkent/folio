import { useRef } from 'react';

import { useFocusTrap } from '@/a11y/focus';
import { Button } from '@/components/common';

import { usePrintStore } from './store';

/** Progress shown while pages are rasterized for the printer. */
export function PrintProgressModal() {
  const status = usePrintStore((s) => s.status);
  const progress = usePrintStore((s) => s.progress);
  const requestCancel = usePrintStore((s) => s.requestCancel);
  const cancelRequested = usePrintStore((s) => s.cancelRequested);

  const dialogRef = useRef<HTMLDivElement>(null);
  const open = status === 'preparing';
  useFocusTrap(dialogRef, open);

  if (!open) return null;

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal folio-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Preparing to print"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">Preparing to print</h2>
        </div>
        <div className="folio-modal__body">
          <p aria-live="polite">
            {progress.total
              ? `Rendering page ${Math.min(progress.current, progress.total)} of ${progress.total}…`
              : 'Applying your edits…'}
          </p>
          <div
            className="folio-ocr-progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="folio-ocr-progress__bar" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="folio-modal__footer">
          <Button onClick={() => requestCancel()} disabled={cancelRequested}>
            {cancelRequested ? 'Stopping…' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  );
}
