import { useEffect, useRef, type ReactNode } from 'react';

import { useFocusTrap } from '@/a11y/focus';

import { IconButton } from './IconButton';

export interface ModalProps {
  /** Rendered only while true; the focus trap arms and disarms with it. */
  open: boolean;
  /** The heading, and the dialog's accessible name. */
  title: string;
  /**
   * What `Escape` and the header's close button do.
   *
   * Omit it for a dialog with no exit of its own -- a question that has to be
   * answered by one of its buttons. A dialog whose only way out is its own
   * Cancel button still passes this (wired to that same cancel) and sets
   * {@link showClose} false: `Escape` is the expected way out of every modal in
   * this app, and a progress dialog that sits in front of the user for minutes
   * is the last one that should be an exception.
   */
  onDismiss?: () => void;
  /**
   * Render the header's close button. Defaults to true whenever `onDismiss` is
   * given. Set false for a dialog whose footer already carries the way out, so
   * the header does not offer a second one that means something subtly
   * different.
   */
  showClose?: boolean;
  /**
   * Make dismissal inert without changing the layout: the close button renders
   * disabled and `Escape` does nothing. For a dialog that has already been
   * asked to stop and is winding down, where removing the control outright
   * would shift everything beside it.
   */
  dismissDisabled?: boolean;
  /** Width preset. Omit for the default. */
  size?: 'narrow' | 'wide';
  /** Extra class on the dialog element, for a feature's own layout. */
  className?: string;
  /**
   * `alertdialog` for an interruption the user must act on before continuing
   * (a confirmation); `dialog`, the default, for everything else.
   */
  role?: 'dialog' | 'alertdialog';
  /** Id of the element describing the dialog, for `aria-describedby`. */
  describedBy?: string;
  /** Everything below the header: the caller's own `folio-modal__body` and `__footer`. */
  children: ReactNode;
}

/**
 * The app's modal dialog: backdrop, focus trap, `Escape`, and the header.
 *
 * Every modal in Folio was a hand-rolled copy of the same twenty lines -- the
 * backdrop div, a ref, `useFocusTrap`, a window `keydown` listener for
 * `Escape`, and a header with an `IconButton` close. Copies drift, and these
 * had: the OCR progress dialog was the one that never grew an `Escape`
 * handler, so the only modal you could be stuck in front of for minutes was
 * also the only one the documented "Escape closes any modal" rule did not
 * apply to.
 *
 * What stays with the caller is layout: `children` is everything under the
 * header, so a feature renders its own `folio-modal__body` and
 * `folio-modal__footer` and can put its own chrome (tabs, a hint line) between
 * them. What lives here is the part that is easy to get subtly wrong and
 * invisible when you do.
 */
export function Modal({
  open,
  title,
  onDismiss,
  showClose,
  dismissDisabled = false,
  size,
  className,
  role = 'dialog',
  describedBy,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Through a ref rather than in the effect's dependencies: `onDismiss` is
  // almost always a fresh closure each render (it reads props and state), so
  // depending on it directly would tear the listener down and rebuild it on
  // every render, and capturing it once would leave `Escape` calling a stale
  // one. Callers used to hand-roll this ref dance; getting it wrong is silent.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  const canDismiss = open && Boolean(onDismiss) && !dismissDisabled;
  useEffect(() => {
    if (!canDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissRef.current?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canDismiss]);

  if (!open) return null;

  const classes = ['folio-modal', size ? `folio-modal--${size}` : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className={classes}
        role={role}
        aria-modal="true"
        aria-label={title}
        aria-describedby={describedBy}
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">{title}</h2>
          {(showClose ?? Boolean(onDismiss)) && (
            <IconButton
              icon="x"
              label="Close"
              disabled={dismissDisabled}
              onClick={() => onDismiss?.()}
            />
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A determinate progress bar for the two dialogs that rasterize page by page.
 * Kept here beside {@link Modal} because both of them are otherwise identical
 * copies of the same markup and ARIA.
 */
export function ModalProgress({ percent }: { percent: number }) {
  return (
    <div
      className="folio-ocr-progress"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="folio-ocr-progress__bar" style={{ width: `${percent}%` }} />
    </div>
  );
}
