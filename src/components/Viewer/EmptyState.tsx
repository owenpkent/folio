import { useState, type DragEvent } from 'react';

import { announce } from '@/a11y/announcer';
import { commandRegistry } from '@/commands';
import { Button, pushToast } from '@/components/common';
import { describeUnreadable, isTauri, readFileBatch } from '@/core/document/openDocument';
import { openDocumentViaPicker, openDroppedPdfs } from '@/state/actions';
import { useDocumentStore } from '@/state/documentStore';

/**
 * Shown when no document is open: a splash screen with the Folio brand and,
 * once startup file handling has settled, the open-a-document controls. While
 * `booting` (the OS may still hand us a launch file) only the brand shows, so
 * double-clicking a PDF never flashes the open UI before the document loads.
 */
export function EmptyState() {
  const booting = useDocumentStore((s) => s.booting);
  const [dragging, setDragging] = useState(false);

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []).filter(
      (file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'),
    );
    if (files.length === 0) return;
    // Same dispatch point the Tauri native drop listener uses (App.tsx): one
    // PDF opens normally, two or more open the combine modal. Kept in sync
    // here rather than re-implemented, and guarded the same way -- a file
    // that fails to read must not drop the rest on the floor, which is what
    // Promise.all did here until readFileBatch replaced it.
    try {
      const { sources, failed } = await readFileBatch(files);
      if (failed.length > 0) {
        const message = describeUnreadable(failed);
        pushToast(message, 'error');
        announce(message, true);
      }
      if (sources.length > 0) await openDroppedPdfs(sources);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not read the file';
      pushToast(`Could not open: ${message}`, 'error');
      announce(`Could not open the dropped file: ${message}`, true);
    }
  };

  return (
    <div
      className={`folio-empty${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="folio-empty__card">
        <svg
          className="folio-empty__logo"
          viewBox="0 0 48 48"
          role="img"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <path d="M10 6h20l8 8v28H10Z" />
          <path d="M30 6v8h8" />
          <path d="M17 22h14M17 29h14M17 36h9" />
        </svg>
        <h1 className="folio-empty__title">Folio</h1>
        <p className="folio-empty__subtitle">A world-class, open-source PDF viewer</p>
        {!booting && (
          <div className="folio-empty__actions">
            <Button variant="primary" onClick={() => openDocumentViaPicker()}>
              Open document…
            </Button>
            <p className="folio-empty__hint">
              Drag a PDF here, or press <kbd>Ctrl/Cmd&nbsp;+&nbsp;O</kbd>
            </p>
            {isTauri() && (
              <Button
                variant="ghost"
                className="folio-empty__default"
                onClick={() => commandRegistry.execute('file.setDefaultViewer')}
              >
                Make Folio your default PDF viewer
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
