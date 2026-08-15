import { useEffect, useRef } from 'react';

import { useFocusTrap } from '@/a11y/focus';

import { Button } from './Button';
import { useConfirmStore } from './confirmStore';

/**
 * Renders whichever question {@link askConfirmation} has outstanding. Mounted
 * once, next to ToastHost, for the same reason that is: the code that needs to
 * ask is deep in a command or an export path with no business rendering a
 * dialog of its own.
 */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  const answer = useConfirmStore((s) => s.answer);
  const dialogRef = useRef<HTMLDivElement>(null);

  useFocusTrap(dialogRef, pending !== null);

  // Escape declines, matching every other modal in the app. Declining rather
  // than confirming is the only safe default for a dismissal: the question is
  // always "shall I go ahead with something that may not be what you want".
  const id = pending?.id;
  useEffect(() => {
    if (id === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer(id, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, answer]);

  if (!pending) return null;

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal folio-modal--narrow"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="folio-confirm-title"
        aria-describedby="folio-confirm-message"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title" id="folio-confirm-title">
            {pending.title}
          </h2>
        </div>

        <div className="folio-modal__body">
          <p id="folio-confirm-message">{pending.message}</p>
        </div>

        <div className="folio-modal__footer">
          {/* The decline is the default focus (useFocusTrap focuses the first
              tabbable), so Enter on an unread dialog takes the cautious path. */}
          <Button onClick={() => answer(pending.id, false)}>{pending.cancelLabel}</Button>
          <Button variant="primary" onClick={() => answer(pending.id, true)}>
            {pending.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
