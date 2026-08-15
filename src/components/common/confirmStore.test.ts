import { beforeEach, describe, expect, it } from 'vitest';

import { askConfirmation, useConfirmStore } from './confirmStore';

const pending = () => useConfirmStore.getState().pending;

const OPTIONS = {
  title: 'Title',
  message: 'Message',
  confirmLabel: 'Go ahead',
  cancelLabel: 'Wait',
};

describe('confirmStore', () => {
  beforeEach(() => useConfirmStore.setState({ pending: null }));

  it('holds the question until it is answered, then resolves with the answer', async () => {
    const answered = askConfirmation(OPTIONS);
    expect(pending()).toMatchObject({ title: 'Title', confirmLabel: 'Go ahead' });

    useConfirmStore.getState().answer(pending()!.id, true);

    await expect(answered).resolves.toBe(true);
    expect(pending()).toBeNull();
  });

  it('resolves false when declined', async () => {
    const answered = askConfirmation(OPTIONS);
    useConfirmStore.getState().answer(pending()!.id, false);
    await expect(answered).resolves.toBe(false);
  });

  it('ignores an answer to a question that is no longer open', async () => {
    const first = askConfirmation(OPTIONS);
    const staleId = pending()!.id;
    useConfirmStore.getState().answer(staleId, true);
    await expect(first).resolves.toBe(true);

    const second = askConfirmation({ ...OPTIONS, title: 'Second' });
    // The first dialog's button firing again (a double click, a replayed
    // event) must not answer the question that is on screen now.
    useConfirmStore.getState().answer(staleId, true);
    expect(pending()).toMatchObject({ title: 'Second' });

    useConfirmStore.getState().answer(pending()!.id, false);
    await expect(second).resolves.toBe(false);
  });

  it('refuses a second question while one is open, rather than replacing it', async () => {
    const first = askConfirmation(OPTIONS);
    // Declining is the safe direction: the caller does nothing. Replacing the
    // open question would leave the first caller's promise unresolved forever,
    // which on the export paths means a Save that never finishes or reports.
    await expect(askConfirmation({ ...OPTIONS, title: 'Second' })).resolves.toBe(false);
    expect(pending()).toMatchObject({ title: 'Title' });

    useConfirmStore.getState().answer(pending()!.id, true);
    await expect(first).resolves.toBe(true);
  });
});
