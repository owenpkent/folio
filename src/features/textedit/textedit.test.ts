import { beforeEach, describe, expect, it } from 'vitest';

import { commandRegistry } from '@/commands';
import { useToastStore } from '@/components/common';
import { useSigningStore } from '@/features/signing';
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
  pdfFontName: 'g_d0_f1',
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

  it('a failed commit pushes nothing, leaving the undo stack and session untouched', () => {
    useTextEditStore.getState().pushUndo(bytesOf(1));
    useTextEditStore.getState().beginSession(session);

    // TextEditLayer's commit flow only calls pushUndo after commitTextEdit
    // resolves, so a failed attempt never pushes a snapshot: nothing needs
    // compensating, and the editor is left open for another try.
    expect(useTextEditStore.getState().undoStack).toEqual([bytesOf(1)]);
    expect(useTextEditStore.getState().session).toEqual(session);
  });
});

describe('textedit commands', () => {
  beforeEach(() => {
    useTextEditStore.getState().reset();
    useDocumentStore.getState().reset();
    useSigningStore.getState().setDetected([]);
    useToastStore.setState({ toasts: [] });
  });

  it('registers the toggle command', () => {
    registerTextEditCommands();
    expect(commandRegistry.has('textedit.toggle')).toBe(true);
  });

  it('registers the undo command', () => {
    registerTextEditCommands();
    expect(commandRegistry.has('textedit.undo')).toBe(true);
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

  it('warns when turning the tool on over a document with detected signatures', async () => {
    registerTextEditCommands();
    useDocumentStore.setState({ status: 'ready' });
    useSigningStore
      .getState()
      .setDetected([{ signerName: 'Jane Doe', signingTime: null, coversWholeDocument: true }]);

    await commandRegistry.execute('textedit.toggle');

    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages.some((m) => m.includes('digitally signed'))).toBe(true);
    // Advisory only: the tool still enables.
    expect(useTextEditStore.getState().active).toBe(true);
  });

  it('does not warn turning the tool on when no signatures are detected', async () => {
    registerTextEditCommands();
    useDocumentStore.setState({ status: 'ready' });

    await commandRegistry.execute('textedit.toggle');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  describe('textedit.undo', () => {
    it('is only enabled once the tool is active', () => {
      registerTextEditCommands();
      useDocumentStore.setState({ status: 'ready' });
      expect(commandRegistry.get('textedit.undo')?.when?.()).toBe(false);

      useTextEditStore.getState().toggleActive();
      expect(commandRegistry.get('textedit.undo')?.when?.()).toBe(true);
    });

    it('is a no-op on an empty undo stack', async () => {
      registerTextEditCommands();
      useDocumentStore.setState({ status: 'ready' });
      useTextEditStore.getState().toggleActive();

      await commandRegistry.execute('textedit.undo');

      expect(useTextEditStore.getState().undoStack).toEqual([]);
    });

    it('pops the undo stack LIFO', async () => {
      registerTextEditCommands();
      // `status: 'ready'` with no `info` satisfies this command's `when`,
      // while reloadEditedBytes's own `!doc.info` guard makes it return
      // before touching the engine, so this exercises the real command path
      // without needing to mock @/core/pdf.
      useDocumentStore.setState({ status: 'ready' });
      useTextEditStore.getState().toggleActive();
      useTextEditStore.getState().pushUndo(bytesOf(1));
      useTextEditStore.getState().pushUndo(bytesOf(2));

      await commandRegistry.execute('textedit.undo');

      expect(useTextEditStore.getState().undoStack).toEqual([bytesOf(1)]);
    });
  });
});
