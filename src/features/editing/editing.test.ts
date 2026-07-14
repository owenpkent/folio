import { beforeEach, describe, expect, it } from 'vitest';

import { commandRegistry } from '@/commands';

import { registerEditCommands } from './commands';
import { useEditStore } from './store';

const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };

describe('edit store', () => {
  beforeEach(() => {
    useEditStore.getState().reset();
    localStorage.clear();
  });

  it('adds a text box and selects/focuses it', () => {
    useEditStore.getState().loadForDocument('fp1');
    const item = useEditStore.getState().addText(1, rect);

    const s = useEditStore.getState();
    expect(s.edits).toHaveLength(1);
    expect(s.edits[0]).toMatchObject({ kind: 'text', pageNumber: 1, text: '' });
    expect(s.selectedId).toBe(item.id);
    expect(s.focusId).toBe(item.id);
  });

  it('updates text style and position', () => {
    useEditStore.getState().loadForDocument('fp1');
    const { id } = useEditStore.getState().addText(1, rect);

    useEditStore.getState().updateText(id, { text: 'hello', bold: true, fontSizePt: 20 });
    useEditStore.getState().move(id, { ...rect, x: 0.5 });

    const item = useEditStore.getState().edits.find((e) => e.id === id);
    expect(item).toMatchObject({ text: 'hello', bold: true, fontSizePt: 20 });
    expect(item?.rect.x).toBe(0.5);
  });

  it('adds an image and removes items, clearing selection', () => {
    useEditStore.getState().loadForDocument('fp1');
    const text = useEditStore.getState().addText(1, rect);
    const image = useEditStore.getState().addImage(1, 'data:image/png;base64,xx', 'image/png', rect);
    expect(useEditStore.getState().edits).toHaveLength(2);
    expect(image.kind).toBe('image');

    useEditStore.getState().select(text.id);
    useEditStore.getState().remove(text.id);
    const s = useEditStore.getState();
    expect(s.edits).toHaveLength(1);
    expect(s.selectedId).toBeNull();
  });

  it('persists per fingerprint across reloads', () => {
    useEditStore.getState().loadForDocument('fp1');
    useEditStore.getState().addText(1, rect);

    // Switch documents (clears in-memory), then reopen the first.
    useEditStore.getState().loadForDocument('fp2');
    expect(useEditStore.getState().edits).toHaveLength(0);

    useEditStore.getState().loadForDocument('fp1');
    expect(useEditStore.getState().edits).toHaveLength(1);
  });
});

describe('edit commands', () => {
  it('registers the add-text and add-image commands', () => {
    registerEditCommands();
    expect(commandRegistry.has('edit.addText')).toBe(true);
    expect(commandRegistry.has('edit.addImage')).toBe(true);
  });
});
