import { useRef } from 'react';

import { useFocusTrap } from '@/a11y/focus';
import { Button } from '@/components/common';

import { useOcrStore } from './store';

/** A modal progress indicator shown while OCR is recognizing pages. */
export function OcrProgressModal() {
  const status = useOcrStore((s) => s.status);
  const progress = useOcrStore((s) => s.progress);
  const requestCancel = useOcrStore((s) => s.requestCancel);
  const cancelRequested = useOcrStore((s) => s.cancelRequested);

  const dialogRef = useRef<HTMLDivElement>(null);
  const open = status === 'running';
  useFocusTrap(dialogRef, open);

  if (!open) return null;

  const pct = progress.total
    ? Math.round(((progress.current - 1 + progress.page) / progress.total) * 100)
    : 0;

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal folio-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label="Recognizing text"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">Recognizing text (OCR)</h2>
        </div>
        <div className="folio-modal__body">
          <p aria-live="polite">
            Recognizing page {Math.min(progress.current, progress.total)} of {progress.total}…
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
