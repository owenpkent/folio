import { beforeEach, describe, expect, it } from 'vitest';

import { commandRegistry } from '@/commands';
import { useDocumentStore } from '@/state/documentStore';

import { registerTextEditCommands } from './commands';
import { useTextEditStore, type EditingSession } from './store';

const session: EditingSession = {
  pageIndex: 0,
  target: { x: 10, y: 20, op: 'Tj' },
  prefillText: 'Hello',
  cssRect: { x: 5, y: 5, width: 40, height: 12 },
  fontFamily: 'Helvetica',
  fontSizePx: 12,
  color: { r: 0, g: 0, b: 0 },
  fontSize: 10,
};

const bytesOf = (n: number) => new Uint8Array([n]);

describe('textedit store', () => {
  beforeEach(() => {
    useTextEditStore.getState().reset();
  });

  it('toggles active', () => {
    expect(useTextEditStore.getState().active).toBe(false);
    useTextEditStore.getState().toggleActive();
    expect(useTextEditStore.getState().active).toBe(true);
    useTextEditStore.getState().toggleActive();
    expect(useTextEditStore.getState().active).toBe(false);
  });

  it('begins and ends a session', () => {
    expect(useTextEditStore.getState().session).toBeNull();

    useTextEditStore.getState().beginSession(session);
    expect(useTextEditStore.getState().session).toEqual(session);

    useTextEditStore.getState().endSession();
    expect(useTextEditStore.getState().session).toBeNull();
  });

  it('caps the undo stack at 10 entries, dropping the oldest', () => {
    for (let i = 0; i < 12; i++) {
      useTextEditStore.getState().pushUndo(bytesOf(i));
    }
    const { undoStack } = useTextEditStore.getState();
    expect(undoStack).toHaveLength(10);
    // 0 and 1 were dropped; the stack keeps 2..11 in push order.
    expect(undoStack[0]).toEqual(bytesOf(2));
    expect(undoStack[9]).toEqual(bytesOf(11));
  });

  it('pops the most recently pushed snapshot (LIFO)', () => {
    useTextEditStore.getState().pushUndo(bytesOf(1));
    useTextEditStore.getState().pushUndo(bytesOf(2));

    const popped = useTextEditStore.getState().popUndo();
    expect(popped).toEqual(bytesOf(2));
    expect(useTextEditStore.getState().undoStack).toEqual([bytesOf(1)]);
  });

  it('returns null popping an empty undo stack', () => {
    expect(useTextEditStore.getState().popUndo()).toBeNull();
  });

  it('discards a pushed snapshot on a failed commit, keeping the session open', () => {
    useTextEditStore.getState().pushUndo(bytesOf(1));
    useTextEditStore.getState().beginSession(session);

    // Optimistic push right before a commit attempt that then fails.
    useTextEditStore.getState().pushUndo(bytesOf(2));
    const popped = useTextEditStore.getState().popUndo();

    expect(popped).toEqual(bytesOf(2));
    expect(useTextEditStore.getState().undoStack).toEqual([bytesOf(1)]);
    // The editor stays open: a failed commit only rolls back the undo push.
    expect(useTextEditStore.getState().session).toEqual(session);
  });
});

describe('textedit commands', () => {
  beforeEach(() => {
    useTextEditStore.getState().reset();
    useDocumentStore.getState().reset();
  });

  it('registers the toggle command', () => {
    registerTextEditCommands();
    expect(commandRegistry.has('textedit.toggle')).toBe(true);
  });

  it('does nothing while no document is open', async () => {
    registerTextEditCommands();
    await commandRegistry.execute('textedit.toggle');
    expect(useTextEditStore.getState().active).toBe(false);
  });

  it('toggling off ends any open session', async () => {
    registerTextEditCommands();
    useDocumentStore.setState({ status: 'ready' });

    await commandRegistry.execute('textedit.toggle');
    expect(useTextEditStore.getState().active).toBe(true);

    useTextEditStore.getState().beginSession(session);
    expect(useTextEditStore.getState().session).not.toBeNull();

    await commandRegistry.execute('textedit.toggle');
    expect(useTextEditStore.getState().active).toBe(false);
    expect(useTextEditStore.getState().session).toBeNull();
  });
});
