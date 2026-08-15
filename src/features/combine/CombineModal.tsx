import { useEffect, useLayoutEffect, useRef } from 'react';

import { announce } from '@/a11y/announcer';
import { useFocusTrap } from '@/a11y/focus';
import { Button, Icon, IconButton } from '@/components/common';
import {
  DOCUMENT_MUTATION_BUSY_TITLE,
  useDocumentMutationBlocked,
} from '@/state/documentMutationStore';

import { addFilesViaPicker, runCombine } from './commands';
import { useCombineStore, type PendingFile } from './store';

/** What to move keyboard focus to once the next render commits, applied by
    the layout effect below. Set by the row handlers instead of focusing
    synchronously, because the target element (or its replacement, when a
    move disables the button under the pointer, or a remove drops the row
    entirely) does not exist in the DOM until after the store update that
    triggered it has re-rendered. */
type PendingFocus = { id: string; which: 'up' | 'down' | 'trash' } | 'add' | null;

/** Modal for merging two or more PDFs into one document. */
export function CombineModal() {
  const open = useCombineStore((s) => s.modalOpen);
  const files = useCombineStore((s) => s.files);
  const busy = useCombineStore((s) => s.busy);
  // Some OTHER feature is mid-flight rewriting the document; a merge cannot
  // start until it clears (see documentMutationStore.ts and runCombine).
  // Owner-scoped, so the button does not blame another feature for the merge
  // this modal itself is running -- `busy` above is what reports that.
  const crossBusy = useDocumentMutationBlocked('combine', 'pages');
  const error = useCombineStore((s) => s.error);
  const progress = useCombineStore((s) => s.progress);
  const cancelRequested = useCombineStore((s) => s.cancelRequested);
  const close = useCombineStore((s) => s.close);
  const requestCancel = useCombineStore((s) => s.requestCancel);
  const removeFile = useCombineStore((s) => s.removeFile);
  const moveUp = useCombineStore((s) => s.moveUp);
  const moveDown = useCombineStore((s) => s.moveDown);

  const dialogRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusRef = useRef<PendingFocus>(null);
  useFocusTrap(dialogRef, open);

  // A run in progress is only ever *asked* to stop -- see dismiss() below --
  // so the modal (and its staged list) stays on screen and in sync with
  // whichever run is actually still live until that run's own cleanup runs.
  // Closing outright here, the way an idle dismiss does, is what used to let
  // a merge keep running behind a modal the user thought they had dismissed,
  // then land on whatever document they had navigated to by the time it
  // finished.
  const dismiss = () => {
    if (busy) requestCancel();
    else close();
  };

  // Escape is the expected way out of every modal in this app, and goes
  // through dismiss() rather than repeating its body: the two used to be
  // identical copies eight lines apart, which would have diverged the first
  // time dismiss() grew a step.
  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Applies whatever the row handlers below queued, once the DOM they target
  // has actually updated. Runs on every `files` change; a no-op whenever
  // nothing is pending (the common case, e.g. a page-count patch landing).
  useLayoutEffect(() => {
    const pending = pendingFocusRef.current;
    pendingFocusRef.current = null;
    if (!pending) return;
    if (pending === 'add') {
      addButtonRef.current?.focus();
      return;
    }
    actionRefs.current.get(`${pending.id}:${pending.which}`)?.focus();
  }, [files]);

  if (!open) return null;

  // A file that failed to read, or that read fine and turned out to have no
  // pages, would otherwise be accepted into a merge that is doomed (or that
  // silently drops it) -- both discovered only after clicking Combine.
  //
  // `!f.pageCount` covers `undefined` as well as `0`, so a file still being
  // read blocks too. It used not to: clicking Combine before "Reading…"
  // resolved sent the merge off to parse that file's bytes a second time,
  // concurrently with the staging parse still in flight, and turned an
  // encrypted file from an up-front block into a mid-merge failure.
  const hasBlockingFile = files.some((f) => Boolean(f.error) || !f.pageCount);
  const canCombine = files.length >= 2 && !busy && !hasBlockingFile && !crossBusy;
  const stopping = busy && cancelRequested;
  const pct = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;
  const progressText = stopping
    ? 'Stopping…'
    : progress.total
      ? `Combining ${Math.min(progress.current, progress.total)} of ${progress.total}…`
      : 'Combining…';

  const handleAddFiles = () => {
    void addFilesViaPicker().then((count) => {
      if (count > 0) announce(`Added ${count} file${count === 1 ? '' : 's'}`);
    });
  };

  const handleMoveUp = (file: PendingFile, index: number) => {
    moveUp(file.id);
    pendingFocusRef.current = { id: file.id, which: index - 1 === 0 ? 'down' : 'up' };
    announce(`Moved ${file.name} up`);
  };

  const handleMoveDown = (file: PendingFile, index: number) => {
    moveDown(file.id);
    pendingFocusRef.current = {
      id: file.id,
      which: index + 1 === files.length - 1 ? 'up' : 'down',
    };
    announce(`Moved ${file.name} down`);
  };

  const handleRemove = (file: PendingFile, index: number) => {
    const remaining = files.filter((f) => f.id !== file.id);
    removeFile(file.id);
    announce(`Removed ${file.name}`);
    pendingFocusRef.current =
      remaining.length === 0
        ? 'add'
        : { id: remaining[Math.min(index, remaining.length - 1)].id, which: 'trash' };
  };

  /** Callback ref for one row action button, keyed for the focus effect above. */
  const actionRef = (key: string) => (el: HTMLButtonElement | null) => {
    if (el) actionRefs.current.set(key, el);
    else actionRefs.current.delete(key);
  };

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
          <IconButton icon="x" label="Close" onClick={dismiss} disabled={stopping} />
        </div>

        <div className="folio-modal__body">
          {files.length === 0 ? (
            <p className="folio-modal__hint">
              Add two or more PDFs below. They will be combined in the order shown, top to bottom.
            </p>
          ) : (
            <ol className="folio-combine-list" aria-label="Files to combine">
              {files.map((file, index) => {
                // Position, not just name: two staged files can share a
                // basename (picked from different folders), which would
                // otherwise give every button on both rows the same
                // accessible name.
                const position = `item ${index + 1} of ${files.length}`;
                return (
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
                        ref={actionRef(`${file.id}:up`)}
                        icon="chevron-up"
                        label={`Move ${file.name} up, ${position}`}
                        disabled={busy || index === 0}
                        onClick={() => handleMoveUp(file, index)}
                      />
                      <IconButton
                        ref={actionRef(`${file.id}:down`)}
                        icon="chevron-down"
                        label={`Move ${file.name} down, ${position}`}
                        disabled={busy || index === files.length - 1}
                        onClick={() => handleMoveDown(file, index)}
                      />
                      <IconButton
                        ref={actionRef(`${file.id}:trash`)}
                        icon="trash"
                        label={`Remove ${file.name}, ${position}`}
                        disabled={busy}
                        onClick={() => handleRemove(file, index)}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          <button
            ref={addButtonRef}
            type="button"
            className="folio-link-button"
            disabled={busy}
            onClick={handleAddFiles}
          >
            <Icon name="plus" size={14} />
            Add PDFs…
          </button>

          {/* Mounted with the dialog and emptied when idle, deliberately
              outside the {busy} block below. A live region inserted into the
              DOM with text already in it is generally not announced --
              assistive tech reports *changes* to a region it is already
              watching. The print and OCR progress modals get away with the
              same markup nested inside their busy check only because their
              whole dialog, focus trap included, mounts at that moment, so
              focus moving into it is the announcement. This dialog is
              already open and focused by the time Combine is clicked, so
              nothing else would speak: a screen-reader user got silence from
              the click through to the end of a fast merge. */}
          <p className="folio-sr-only" aria-live="polite">
            {busy ? progressText : ''}
          </p>

          {busy && (
            <div className="folio-combine-progress">
              {/* Shown to sighted users; the live region above carries the
                  same words for everyone else. aria-hidden so the two are
                  not read as a duplicate pair. The progressbar's own
                  aria-valuenow updates too fast to announce every step. */}
              <p className="folio-combine-progress__text" aria-hidden="true">
                {progressText}
              </p>
              <div
                className="folio-ocr-progress"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Combine progress"
              >
                <div className="folio-ocr-progress__bar" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {error && (
            <p className="folio-modal__error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="folio-modal__footer">
          <Button onClick={dismiss} disabled={stopping}>
            {stopping ? 'Stopping…' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={!canCombine}
            title={crossBusy ? DOCUMENT_MUTATION_BUSY_TITLE : undefined}
            onClick={() => void runCombine()}
          >
            {busy ? 'Combining…' : 'Combine'}
          </Button>
        </div>
      </div>
    </div>
  );
}
