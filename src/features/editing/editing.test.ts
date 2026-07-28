import { beforeEach, describe, expect, it } from 'vitest';

import { commandRegistry } from '@/commands';
import { usePlacementStore } from '@/features/placement';
import { useDocumentStore } from '@/state/documentStore';

import { beginMarkPlacement, registerEditCommands } from './commands';
import { useEditStore } from './store';

const rect = { x: 0.1, y: 0.1, width: 0.3, height: 0.1 };

describe('edit store', () => {
  beforeEach(() => {
    useEditStore.getState().reset();
    // The placement and document stores are global; reset both so no test can
    // leave a placement armed (or a document "open") for the next one.
    usePlacementStore.getState().cancel();
    useDocumentStore.setState({ status: 'empty' });
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
    const image = useEditStore
      .getState()
      .addImage(1, 'data:image/png;base64,xx', 'image/png', rect);
    expect(useEditStore.getState().edits).toHaveLength(2);
    expect(image.kind).toBe('image');

    useEditStore.getState().select(text.id);
    useEditStore.getState().remove(text.id);
    const s = useEditStore.getState();
    expect(s.edits).toHaveLength(1);
    expect(s.selectedId).toBeNull();
  });

  it('adds a check mark and selects it', () => {
    useEditStore.getState().loadForDocument('fp1');
    const item = useEditStore.getState().addMark(1, rect, 'check');

    const s = useEditStore.getState();
    expect(s.edits).toHaveLength(1);
    expect(s.edits[0]).toMatchObject({ kind: 'mark', pageNumber: 1, glyph: 'check' });
    expect(item.colorHex).toMatch(/^#[0-9a-f]{6}$/i);
    expect(s.selectedId).toBe(item.id);
  });

  it('switches a mark between check and cross glyphs', () => {
    useEditStore.getState().loadForDocument('fp1');
    const { id } = useEditStore.getState().addMark(1, rect, 'check');

    useEditStore.getState().updateMark(id, { glyph: 'cross' });
    expect(useEditStore.getState().edits.find((e) => e.id === id)).toMatchObject({
      glyph: 'cross',
    });

    useEditStore.getState().updateMark(id, { glyph: 'check' });
    expect(useEditStore.getState().edits.find((e) => e.id === id)).toMatchObject({
      glyph: 'check',
    });
  });

  it('moves and removes a check mark like any other edit', () => {
    useEditStore.getState().loadForDocument('fp1');
    const { id } = useEditStore.getState().addMark(1, rect, 'cross');

    useEditStore.getState().move(id, { ...rect, x: 0.6 });
    expect(useEditStore.getState().edits.find((e) => e.id === id)?.rect.x).toBe(0.6);

    useEditStore.getState().remove(id);
    expect(useEditStore.getState().edits).toHaveLength(0);
  });

  it('arms check-mark placement through the shared placement store', () => {
    // The check-mark tool has no armed flag of its own: it goes through
    // features/placement like add-text, add-image and add-signature, so the one
    // hint banner and one Escape handler cover all four.
    useEditStore.getState().loadForDocument('fp1');
    expect(usePlacementStore.getState().pending).toBeNull();

    // Refuses to arm with no document open, like the other placing tools.
    beginMarkPlacement();
    expect(usePlacementStore.getState().pending).toBeNull();

    useDocumentStore.setState({ status: 'ready' });
    beginMarkPlacement();
    const pending = usePlacementStore.getState().pending;
    expect(pending?.label).toBe('check mark');
    // The only placing tool that yields to a real AcroForm widget, since a mark
    // exists to stand in for a checkbox that has no field behind it.
    expect(pending?.deferToFormWidget).toBe(true);

    usePlacementStore.getState().cancel();
    expect(usePlacementStore.getState().pending).toBeNull();
  });

  it('persists per fingerprint across reloads', () => {
    useEditStore.getState().loadForDocument('fp1');
    useEditStore.getState().addText(1, rect);
    useEditStore.getState().addMark(1, rect, 'cross');

    // Switch documents (clears in-memory), then reopen the first.
    useEditStore.getState().loadForDocument('fp2');
    expect(useEditStore.getState().edits).toHaveLength(0);

    useEditStore.getState().loadForDocument('fp1');
    const edits = useEditStore.getState().edits;
    expect(edits).toHaveLength(2);
    // The mark's kind-specific fields (glyph, colorHex) round-trip through
    // JSON untouched: persistence is generic over EditItem, no special-casing.
    expect(edits.find((e) => e.kind === 'mark')).toMatchObject({
      kind: 'mark',
      glyph: 'cross',
      colorHex: expect.stringMatching(/^#[0-9a-f]{6}$/i),
    });
  });
});

describe('edit commands', () => {
  it('registers the add-text and add-image commands', () => {
    registerEditCommands();
    expect(commandRegistry.has('edit.addText')).toBe(true);
    expect(commandRegistry.has('edit.addImage')).toBe(true);
  });

  it('registers the add-checkmark command', () => {
    registerEditCommands();
    expect(commandRegistry.has('edit.addCheckmark')).toBe(true);
  });
});
