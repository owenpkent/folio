import { beforeEach, describe, expect, it } from 'vitest';

import { commandRegistry } from '@/commands';
import { useToastStore } from '@/components/common';
import { useSigningStore } from '@/features/signing';
import { useDocumentStore } from '@/state/documentStore';

import { registerImageEditCommands } from './commands';
import { useImageEditStore } from './store';
import type { SelectedImage } from './types';

const selection: SelectedImage = {
  pageIndex: 0,
  streamIndex: 0,
  name: 'Im1',
  rect: { x: 10, y: 20, width: 100, height: 80 },
};

describe('imageedit store', () => {
  beforeEach(() => {
    useImageEditStore.getState().reset();
  });

  it('toggles active', () => {
    expect(useImageEditStore.getState().active).toBe(false);
    useImageEditStore.getState().toggleActive();
    expect(useImageEditStore.getState().active).toBe(true);
    useImageEditStore.getState().toggleActive();
    expect(useImageEditStore.getState().active).toBe(false);
  });

  it('selects and deselects an image', () => {
    expect(useImageEditStore.getState().selected).toBeNull();

    useImageEditStore.getState().select(selection);
    expect(useImageEditStore.getState().selected).toEqual(selection);

    useImageEditStore.getState().select(null);
    expect(useImageEditStore.getState().selected).toBeNull();
  });

  it('reset clears both active and selected', () => {
    useImageEditStore.getState().toggleActive();
    useImageEditStore.getState().select(selection);

    useImageEditStore.getState().reset();

    expect(useImageEditStore.getState().active).toBe(false);
    expect(useImageEditStore.getState().selected).toBeNull();
  });
});

describe('imageedit commands', () => {
  beforeEach(() => {
    useImageEditStore.getState().reset();
    useDocumentStore.getState().reset();
    useSigningStore.getState().setDetected([]);
    useToastStore.setState({ toasts: [] });
  });

  it('registers the toggle command', () => {
    registerImageEditCommands();
    expect(commandRegistry.has('imageedit.toggle')).toBe(true);
  });

  it('does nothing while no document is open', async () => {
    registerImageEditCommands();
    await commandRegistry.execute('imageedit.toggle');
    expect(useImageEditStore.getState().active).toBe(false);
  });

  it('toggling off clears any selection', async () => {
    registerImageEditCommands();
    useDocumentStore.setState({ status: 'ready' });

    await commandRegistry.execute('imageedit.toggle');
    expect(useImageEditStore.getState().active).toBe(true);

    useImageEditStore.getState().select(selection);
    expect(useImageEditStore.getState().selected).not.toBeNull();

    await commandRegistry.execute('imageedit.toggle');
    expect(useImageEditStore.getState().active).toBe(false);
    expect(useImageEditStore.getState().selected).toBeNull();
  });

  it('warns when turning the tool on over a document with detected signatures', async () => {
    registerImageEditCommands();
    useDocumentStore.setState({ status: 'ready' });
    useSigningStore
      .getState()
      .setDetected([{ signerName: 'Jane Doe', signingTime: null, coversWholeDocument: true }]);

    await commandRegistry.execute('imageedit.toggle');

    const messages = useToastStore.getState().toasts.map((t) => t.message);
    expect(messages.some((m) => m.includes('digitally signed'))).toBe(true);
    // Advisory only: the tool still enables.
    expect(useImageEditStore.getState().active).toBe(true);
  });

  it('does not warn turning the tool on when no signatures are detected', async () => {
    registerImageEditCommands();
    useDocumentStore.setState({ status: 'ready' });

    await commandRegistry.execute('imageedit.toggle');

    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
