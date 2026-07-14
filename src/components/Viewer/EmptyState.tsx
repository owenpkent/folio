import { useState, type DragEvent } from 'react';

import { commandRegistry } from '@/commands';
import { Button } from '@/components/common';
import { isTauri, sourceFromFile } from '@/core/document/openDocument';
import { loadSource, openDocumentViaPicker } from '@/state/actions';

/** Shown when no document is open: an open button and a drop target. */
export function EmptyState() {
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
        <h1 className="folio-empty__title">Folio</h1>
        <p className="folio-empty__subtitle">A world-class, open-source PDF viewer</p>
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
    </div>
  );
}
