import { Button } from './Button';
import { useConfirmStore } from './confirmStore';
import { Modal } from './Modal';

const MESSAGE_ID = 'folio-confirm-message';

/**
 * Renders whichever question {@link askConfirmation} has outstanding. Mounted
 * once, next to ToastHost, for the same reason that is: the code that needs to
 * ask is deep in a command or an export path with no business rendering a
 * dialog of its own.
 */
export function ConfirmHost() {
  const pending = useConfirmStore((s) => s.pending);
  const answer = useConfirmStore((s) => s.answer);

  return (
    <Modal
      open={pending !== null}
      title={pending?.title ?? ''}
      // Escape declines, matching every other modal in the app. Declining
      // rather than confirming is the only safe reading of a dismissal: the
      // question is always "shall I go ahead with something that may not be
      // what you want".
      onDismiss={pending ? () => answer(pending.id, false) : undefined}
      // The footer carries both answers, named. A header X would be a third
      // control meaning the same as one of them but saying nothing about which.
      showClose={false}
      // Not a plain dialog: this interrupts to report a condition the user has
      // to act on before the thing they asked for can proceed.
      role="alertdialog"
      describedBy={MESSAGE_ID}
      size="narrow"
    >
      {pending && (
        <>
          <div className="folio-modal__body">
            <p id={MESSAGE_ID}>{pending.message}</p>
          </div>
          <div className="folio-modal__footer">
            {/* The decline comes first so the focus trap's initial focus, and
                an unread Enter, both land on the reversible choice. */}
            <Button onClick={() => answer(pending.id, false)}>{pending.cancelLabel}</Button>
            <Button variant="primary" onClick={() => answer(pending.id, true)}>
              {pending.confirmLabel}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
