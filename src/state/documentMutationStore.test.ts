import { beforeEach, describe, expect, it } from 'vitest';

import {
  documentMutationBlocked,
  useDocumentMutationStore,
  withDocumentMutation,
  type MutationOwner,
  type MutationScope,
} from './documentMutationStore';

const reset = () => useDocumentMutationStore.setState({ active: [] });
const acquire = (owner: MutationOwner, scope: MutationScope) =>
  useDocumentMutationStore.getState().acquire({ owner, scope });

describe('documentMutationStore', () => {
  beforeEach(reset);

  it('starts idle', () => {
    expect(useDocumentMutationStore.getState().active).toEqual([]);
  });

  it('acquire takes the lock and its release gives it back', () => {
    const release = acquire('pageops', 'pages');
    expect(release).not.toBeNull();
    expect(documentMutationBlocked('textedit', 'content')).toBe(true);

    release?.();
    expect(useDocumentMutationStore.getState().active).toEqual([]);
    expect(documentMutationBlocked('textedit', 'content')).toBe(false);
  });

  it('refuses a second conflicting acquire while one is held', () => {
    expect(acquire('pageops', 'pages')).not.toBeNull();
    expect(acquire('textedit', 'content')).toBeNull();
  });

  it('does not report an operation as blocked by its own owner', () => {
    acquire('pageops', 'pages');
    // pageops' own busy flag is what reports this to pageops' own UI; the
    // cross-feature title ("Another document change...") must not.
    expect(documentMutationBlocked('pageops', 'pages')).toBe(false);
    expect(documentMutationBlocked('combine', 'pages')).toBe(true);
  });

  it('lets an OCR sidecar run and a content-only change overlap', () => {
    const releaseOcr = acquire('ocr', 'sidecar');
    expect(releaseOcr).not.toBeNull();
    // The one pair allowed to overlap: recognition writes the OCR store for
    // the page map it started on, and a save or an in-place edit leaves that
    // page map alone. Blocking these was what froze Save for a multi-minute run.
    expect(acquire('export', 'content')).not.toBeNull();
    expect(documentMutationBlocked('export', 'content')).toBe(false);
    // A page op does renumber the pages, so it still waits.
    expect(acquire('pageops', 'pages')).toBeNull();
    expect(documentMutationBlocked('pageops', 'pages')).toBe(true);
  });

  it('a superseded release cannot unlock the operation running now', () => {
    const first = acquire('textedit', 'content');
    first?.();
    const second = acquire('pageops', 'pages');
    expect(second).not.toBeNull();

    // A double release from the first holder (a stray finally, a retried
    // cleanup) must not drop the page op that has since taken the lock. The
    // old begin()/end() pair cleared the flag regardless of who set it, which
    // is why callers had to hand-roll "do I own this?" bookkeeping.
    first?.();
    expect(documentMutationBlocked('textedit', 'content')).toBe(true);
    expect(useDocumentMutationStore.getState().active).toHaveLength(1);
  });

  it('withDocumentMutation releases the lock when the body throws', async () => {
    const failure = new Error('commit failed');
    await expect(
      withDocumentMutation(
        { owner: 'imageedit', scope: 'content' },
        () => Promise.reject(failure),
        () => undefined,
      ),
    ).rejects.toBe(failure);

    expect(useDocumentMutationStore.getState().active).toEqual([]);
  });

  it('withDocumentMutation runs onBusy instead of the body when blocked', async () => {
    acquire('pageops', 'pages');
    let ran = false;

    const result = await withDocumentMutation(
      { owner: 'textedit', scope: 'content' },
      async () => {
        ran = true;
        return 'committed';
      },
      () => 'busy',
    );

    expect(ran).toBe(false);
    expect(result).toBe('busy');
    // The refused caller must not have released the holder's lock on its way out.
    expect(useDocumentMutationStore.getState().active).toHaveLength(1);
  });
});
