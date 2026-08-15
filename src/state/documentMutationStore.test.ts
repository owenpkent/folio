import { beforeEach, describe, expect, it } from 'vitest';

import { useDocumentMutationStore } from './documentMutationStore';

describe('documentMutationStore', () => {
  beforeEach(() => useDocumentMutationStore.getState().end());

  it('starts idle', () => {
    expect(useDocumentMutationStore.getState().inFlight).toBe(false);
  });

  it('begin sets inFlight, end clears it', () => {
    useDocumentMutationStore.getState().begin();
    expect(useDocumentMutationStore.getState().inFlight).toBe(true);
    useDocumentMutationStore.getState().end();
    expect(useDocumentMutationStore.getState().inFlight).toBe(false);
  });

  it('end is safe to call when nothing is in flight', () => {
    // A feature's own finally block always calls end(), including on a path
    // where begin() was never reached (e.g. an early guard clause returned
    // first). That must not throw or leave inFlight in a surprising state.
    useDocumentMutationStore.getState().end();
    expect(useDocumentMutationStore.getState().inFlight).toBe(false);
  });
});
