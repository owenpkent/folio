import { useEffect, useRef } from 'react';

import { useFocusTrap } from '@/a11y/focus';
import { Button, IconButton } from '@/components/common';

import { addFilesViaPicker, runCombine } from './commands';
import { useCombineStore } from './store';

/** Modal for merging two or more PDFs into one document. */
export function CombineModal() {
  const open = useCombineStore((s) => s.modalOpen);
  const files = useCombineStore((s) => s.files);
  const busy = useCombineStore((s) => s.busy);
  const error = useCombineStore((s) => s.error);
  const close = useCombineStore((s) => s.close);
  const removeFile = useCombineStore((s) => s.removeFile);
  const moveUp = useCombineStore((s) => s.moveUp);
  const moveDown = useCombineStore((s) => s.moveDown);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Escape is the expected way out of every modal in this app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const canCombine = files.length >= 2 && !busy;

  return (
    <div className="folio-modal-backdrop">
      <div
        ref={dialogRef}
        className="folio-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Combine PDFs"
      >
        <div className="folio-modal__header">
          <h2 className="folio-modal__title">Combine PDFs</h2>
          <IconButton icon="x" label="Close" onClick={close} />
        </div>

        <div className="folio-modal__body">
          {files.length === 0 ? (
            <p className="folio-modal__hint">
              Add two or more PDFs below. They will be combined in the order shown, top to bottom.
            </p>
          ) : (
            <ol className="folio-combine-list" aria-label="Files to combine">
              {files.map((file, index) => (
                <li key={file.id} className="folio-combine-list__item">
                  <div className="folio-combine-list__info">
                    <span className="folio-combine-list__name">{file.name}</span>
                    <span className={`folio-combine-list__meta${file.error ? ' is-error' : ''}`}>
                      {file.error
                        ? file.error
                        : file.pageCount === undefined
                          ? 'Reading…'
                          : `${file.pageCount} page${file.pageCount === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  <div className="folio-combine-list__actions">
                    <IconButton
                      icon="chevron-up"
                      label={`Move ${file.name} up`}
                      disabled={index === 0}
                      onClick={() => moveUp(file.id)}
                    />
                    <IconButton
                      icon="chevron-down"
                      label={`Move ${file.name} down`}
                      disabled={index === files.length - 1}
                      onClick={() => moveDown(file.id)}
                    />
                    <IconButton
                      icon="trash"
                      label={`Remove ${file.name}`}
                      onClick={() => removeFile(file.id)}
                    />
                  </div>
                </li>
              ))}
            </ol>
          )}

          <button
            type="button"
            className="folio-link-button"
            disabled={busy}
            onClick={() => void addFilesViaPicker()}
          >
            + Add PDFs…
          </button>

          {error && (
            <p className="folio-modal__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="folio-modal__footer">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!canCombine} onClick={() => void runCombine()}>
            {busy ? 'Combining…' : 'Combine'}
          </Button>
        </div>
      </div>
    </div>
  );
}
