import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { announce } from '@/a11y/announcer';
import { Icon } from '@/components/common';

import { clamp01, NOTE_COLOR, textNearAnchor, useNotesUi } from './notesUi';
import { useAnnotationStore } from './store';
import type { Annotation } from './types';

/**
 * Interactive sticky notes over a page: place (in "adding" mode), drag to move,
 * click to open a comment editor. Highlights are drawn by AnnotationLayer.
 */
export function NotesLayer({ pageNumber }: { pageNumber: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const all = useAnnotationStore((s) => s.annotations);
  const addNote = useAnnotationStore((s) => s.addNote);
  const moveNote = useAnnotationStore((s) => s.moveNote);
  const adding = useNotesUi((s) => s.adding);
  const activeId = useNotesUi((s) => s.activeId);
  const setAdding = useNotesUi((s) => s.setAdding);
  const setActive = useNotesUi((s) => s.setActive);

  const notes = useMemo(
    () => all.filter((a) => a.type === 'note' && a.pageNumber === pageNumber),
    [all, pageNumber],
  );

  const [dragId, setDragId] = useState<string | null>(null);
  const movedRef = useRef(false);

  const place = (clientX: number, clientY: number) => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const anchor = {
      x: clamp01((clientX - r.left) / r.width),
      y: clamp01((clientY - r.top) / r.height),
    };
    // The text layer is a sibling of the notes layer, so query from the page.
    const pageEl = el.closest<HTMLElement>('.folio-page') ?? el;
    const context = textNearAnchor(pageEl, anchor);
    const note = addNote(pageNumber, anchor, context, NOTE_COLOR);
    setAdding(false);
    setActive(note.id);
    announce(`Note added on page ${pageNumber}`);
  };

  const activeNote = notes.find((n) => n.id === activeId) ?? null;

  return (
    <div ref={rootRef} className="folio-notes-layer">
      {adding && (
        <button
          type="button"
          className="folio-notes-place"
          aria-label="Click where you want to place a note"
          title="Click where you want to place a note"
          onClick={(e) => place(e.clientX, e.clientY)}
        />
      )}

      {notes.map((note) => {
        const x = (note.anchor?.x ?? 0.5) * 100;
        const y = (note.anchor?.y ?? 0.5) * 100;
        return (
          <Fragment key={note.id}>
            {/* Underline the referenced text for selection-anchored comments. */}
            {note.rects?.map((r, i) => (
              <div
                key={i}
                className={`folio-note-mark${note.id === activeId ? ' is-active' : ''}`}
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.width * 100}%`,
                  height: `${r.height * 100}%`,
                }}
              />
            ))}
            <button
              className={`folio-note-pin${note.id === activeId ? ' is-active' : ''}${note.note ? '' : ' is-empty'}`}
              style={{ left: `${x}%`, top: `${y}%` }}
              aria-label={note.note ? `Note: ${note.note}` : 'Empty note'}
              // Lets a reader skim notes on hover without opening each pin.
              title={note.note || 'Empty note'}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                movedRef.current = false;
                setDragId(note.id);
              }}
              onPointerMove={(e) => {
                if (dragId !== note.id) return;
                const el = rootRef.current;
                if (!el) return;
                const r = el.getBoundingClientRect();
                movedRef.current = true;
                moveNote(note.id, {
                  x: clamp01((e.clientX - r.left) / r.width),
                  y: clamp01((e.clientY - r.top) / r.height),
                });
              }}
              onPointerUp={() => {
                setDragId(null);
                if (!movedRef.current) setActive(activeId === note.id ? null : note.id);
              }}
            >
              <Icon name="comment" size={13} />
            </button>
          </Fragment>
        );
      })}

      {activeNote && <NoteEditor note={activeNote} />}
    </div>
  );
}

function NoteEditor({ note }: { note: Annotation }) {
  const setNote = useAnnotationStore((s) => s.setNote);
  const remove = useAnnotationStore((s) => s.remove);
  const setActive = useNotesUi((s) => s.setActive);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const x = (note.anchor?.x ?? 0.5) * 100;
  const y = (note.anchor?.y ?? 0.5) * 100;
  const snippet = note.text ? note.text.slice(0, 80) + (note.text.length > 80 ? '…' : '') : '';

  return (
    <div
      className="folio-note-editor"
      style={{ left: `${x}%`, top: `${y}%` }}
      role="dialog"
      aria-label={`Note on page ${note.pageNumber}`}
    >
      <textarea
        ref={ref}
        className="folio-note-editor__text"
        placeholder="Add a comment…"
        defaultValue={note.note}
        aria-label="Note comment"
        onChange={(e) => setNote(note.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setActive(null);
        }}
      />
      {snippet && (
        <p className="folio-note-editor__context" title={note.text}>
          Near: &ldquo;{snippet}&rdquo;
        </p>
      )}
      <div className="folio-note-editor__actions">
        <button
          type="button"
          className="folio-note-editor__btn folio-note-editor__btn--danger"
          onClick={() => {
            remove(note.id);
            setActive(null);
          }}
        >
          Delete
        </button>
        <button
          type="button"
          className="folio-note-editor__btn"
          onClick={() => setActive(null)}
        >
          Done
        </button>
      </div>
    </div>
  );
}
