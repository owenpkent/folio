import { afterEach, describe, expect, it, vi } from 'vitest';

const { askConfirmation } = vi.hoisted(() => ({ askConfirmation: vi.fn() }));

vi.mock('@/components/common/confirmStore', () => ({ askConfirmation }));

import { confirmIncompleteOcr } from './confirmIncompleteOcr';
import { useOcrStore } from './store';

/** Put the store into a whole-document run that has finished `done` of `total`. */
function runningWith(done: number, total: number): void {
  const pages = Object.fromEntries(
    Array.from({ length: done }, (_, i) => [i + 1, { pageNumber: i + 1, words: [], text: '' }]),
  );
  useOcrStore.setState({
    status: 'running',
    pages,
    progress: { current: done, total, page: 0 },
  });
}

describe('confirmIncompleteOcr', () => {
  afterEach(() => {
    useOcrStore.getState().reset();
    askConfirmation.mockReset();
  });

  it('does not ask when no recognition is running', async () => {
    useOcrStore.setState({ status: 'done', progress: { current: 0, total: 0, page: 0 } });

    await expect(confirmIncompleteOcr('save')).resolves.toBe(true);
    expect(askConfirmation).not.toHaveBeenCalled();
  });

  it('does not ask for a single-page run', async () => {
    // `ocr.recognizePage` is over in seconds; a dialog would be more
    // interruption than the warning is worth.
    runningWith(0, 1);

    await expect(confirmIncompleteOcr('save')).resolves.toBe(true);
    expect(askConfirmation).not.toHaveBeenCalled();
  });

  it('asks during a whole-document run, naming how much is done', async () => {
    runningWith(40, 300);
    askConfirmation.mockResolvedValue(true);

    await expect(confirmIncompleteOcr('save')).resolves.toBe(true);
    expect(askConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('40 of 300'),
        confirmLabel: 'Save anyway',
      }),
    );
  });

  it('passes the refusal back, so the caller does not export', async () => {
    runningWith(40, 300);
    askConfirmation.mockResolvedValue(false);

    await expect(confirmIncompleteOcr('save')).resolves.toBe(false);
  });

  it('names the action that is asking', async () => {
    runningWith(1, 10);
    askConfirmation.mockResolvedValue(true);

    await confirmIncompleteOcr('print');
    expect(askConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: 'Print anyway',
        // Singular, because exactly one page is done.
        message: expect.stringContaining('1 of 10 page has'),
      }),
    );

    await confirmIncompleteOcr('sign');
    expect(askConfirmation).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmLabel: 'Sign anyway' }),
    );
  });
});
