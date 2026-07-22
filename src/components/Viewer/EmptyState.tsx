import { useState, type DragEvent } from 'react';

import { commandRegistry } from '@/commands';
import { Button } from '@/components/common';
import { isTauri, sourceFromFile } from '@/core/document/openDocument';
import { loadSource, openDocumentViaPicker } from '@/state/actions';
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
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
      await loadSource(await sourceFromFile(file));
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
