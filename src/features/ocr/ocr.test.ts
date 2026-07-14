import { beforeEach, describe, expect, it, vi } from 'vitest';

import { commandRegistry } from '@/commands';
import type * as PdfCore from '@/core/pdf';

// The search fallback calls the engine; stub it so the test needs no real document.
vi.mock('@/core/pdf', async (orig) => {
  const actual = (await orig()) as typeof PdfCore;
  return { ...actual, getEngine: () => ({ search: async () => [] }) };
});

import { registerOcrCommands } from './commands';
import { searchWithOcr } from './search';
import { useOcrStore } from './store';
import type { OcrPage } from './types';

const samplePage: OcrPage = {
  pageNumber: 2,
  text: 'the quick brown fox',
  words: [{ text: 'quick', rect: { x: 0.1, y: 0.1, width: 0.1, height: 0.02 } }],
};

describe('ocr store', () => {
  beforeEach(() => {
    useOcrStore.getState().reset();
    localStorage.clear();
  });

  it('tracks progress and stores recognized pages', () => {
    useOcrStore.getState().loadForDocument('fp1');
    useOcrStore.getState().start(3);
    expect(useOcrStore.getState().status).toBe('running');

    useOcrStore.getState().setProgress(2, 0.5);
    expect(useOcrStore.getState().progress).toMatchObject({ current: 2, total: 3, page: 0.5 });

    useOcrStore.getState().setPage(samplePage);
    useOcrStore.getState().finish();
    const s = useOcrStore.getState();
    expect(s.status).toBe('done');
    expect(s.pages[2]).toMatchObject({ pageNumber: 2, text: 'the quick brown fox' });
  });

  it('persists per fingerprint and reports done on reload', () => {
    useOcrStore.getState().loadForDocument('fp1');
    useOcrStore.getState().setPage(samplePage);

    useOcrStore.getState().loadForDocument('fp2');
    expect(Object.keys(useOcrStore.getState().pages)).toHaveLength(0);
    expect(useOcrStore.getState().status).toBe('idle');

    useOcrStore.getState().loadForDocument('fp1');
    expect(useOcrStore.getState().status).toBe('done');
    expect(useOcrStore.getState().pages[2]).toBeDefined();
  });
});

describe('searchWithOcr', () => {
  beforeEach(() => {
    useOcrStore.getState().reset();
    localStorage.clear();
  });

  it('returns OCR matches when the engine finds none', async () => {
    useOcrStore.getState().loadForDocument('fp1');
    useOcrStore.getState().setPage(samplePage);

    const results = await searchWithOcr('quick', { limit: 100 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pageNumber: 2 });
    expect(results[0].snippet.toLowerCase()).toContain('quick');
  });

  it('returns nothing extra when the query is not in the OCR text', async () => {
    useOcrStore.getState().loadForDocument('fp1');
    useOcrStore.getState().setPage(samplePage);
    expect(await searchWithOcr('elephant', { limit: 100 })).toHaveLength(0);
  });
});

describe('ocr commands', () => {
  it('registers the recognize commands', () => {
    registerOcrCommands();
    expect(commandRegistry.has('ocr.recognizeDocument')).toBe(true);
    expect(commandRegistry.has('ocr.recognizePage')).toBe(true);
  });
});
