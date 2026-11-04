import { beforeEach, describe, expect, it, vi } from 'vitest';

const createWorker = vi.fn();

vi.mock('tesseract.js', () => ({
  createWorker: (...args: unknown[]) => createWorker(...args),
  OEM: { LSTM_ONLY: 1 },
}));

function fakeWorker() {
  return {
    recognize: vi.fn().mockResolvedValue({ data: { blocks: [], text: 'hello' } }),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('recognizeImage worker caching', () => {
  beforeEach(() => {
    vi.resetModules();
    createWorker.mockReset();
  });

  it('retries worker creation after a failed attempt', async () => {
    createWorker.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(fakeWorker());
    const { recognizeImage } = await import('./recognize');

    await expect(recognizeImage('data:,', 10, 10)).rejects.toThrow('offline');
    await expect(recognizeImage('data:,', 10, 10)).resolves.toEqual({ words: [], text: 'hello' });
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('replaces a worker whose recognize call failed', async () => {
    const bad = fakeWorker();
    bad.recognize.mockRejectedValue(new Error('crashed'));
    createWorker.mockResolvedValueOnce(bad).mockResolvedValueOnce(fakeWorker());
    const { recognizeImage } = await import('./recognize');

    await expect(recognizeImage('data:,', 10, 10)).rejects.toThrow('crashed');
    expect(bad.terminate).toHaveBeenCalledTimes(1);
    await expect(recognizeImage('data:,', 10, 10)).resolves.toMatchObject({ text: 'hello' });
    expect(createWorker).toHaveBeenCalledTimes(2);
  });
});
