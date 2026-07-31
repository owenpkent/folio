import { useEffect, useRef } from 'react';

import { useFocusTrap } from '@/a11y/focus';
import { Button } from '@/components/common';

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

  const dialogRef = useRef<HTMLDivElement>(null);
  const open = status === 'preparing';
  useFocusTrap(dialogRef, open);

  // Escape is the expected way out of any modal in this app, and this one is
  // in front of the user for as long as a long document takes to rasterize.
  useEffect(() => {
    if (!open || cancelRequested) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, cancelRequested, requestCancel]);

  if (!open) return null;

  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;
  const announced = Math.floor(pct / ANNOUNCE_STEP_PCT) * ANNOUNCE_STEP_PCT;

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
