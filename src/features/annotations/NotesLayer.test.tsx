import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { NotesLayer } from './NotesLayer';
import { NOTE_COLOR, useNotesUi } from './notesUi';
import { useAnnotationStore } from './store';

describe('NotesLayer', () => {
  afterEach(() => {
    cleanup();
    useAnnotationStore.getState().reset();
    useNotesUi.setState({ adding: false, activeId: null });
  });

  it('opens a pin note from the keyboard, not just from pointer events', async () => {
    const note = useAnnotationStore
      .getState()
      .addNote(1, { x: 0.5, y: 0.5 }, 'nearby text', NOTE_COLOR);

    render(<NotesLayer pageNumber={1} />);

    // jsdom never fires pointer events on its own, so Tab+Enter is the only
    // way to reach this pin the way a keyboard user actually would: no
    // pointerdown/pointerup, just focus and a key press.
    const pin = screen.getByRole('button', { name: 'Empty note' });
    pin.focus();
    await userEvent.setup().keyboard('{Enter}');

    expect(useNotesUi.getState().activeId).toBe(note.id);
    expect(screen.getByRole('dialog', { name: 'Note on page 1' })).toBeInTheDocument();
  });
});
